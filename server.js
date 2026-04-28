const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const url = require('url');

const app = express();
const server = http.createServer(app);

const SERVER_START = Date.now();

// 用 noServer 模式，自己处理 upgrade 以区分路径
const wss = new WebSocket.Server({ noServer: true });

// 存储最新的欧拉角数据
let latestEuler = { roll: 0, pitch: 0, yaw: 0 };

// 环形缓冲区：保存最近 1000 条记录（含时间戳 + 四元数/欧拉角 + 延迟）
const HISTORY_LIMIT = 1000;
const historyBuffer = [];
function pushHistory(record) {
    historyBuffer.push(record);
    if (historyBuffer.length > HISTORY_LIMIT) {
        historyBuffer.shift();
    }
}

// ESP32 在线状态
let espConnected = false;

// 存储浏览器 WS 客户端（用来可视化）
const browserClients = new Set();
// 存储 ESP32 WS 客户端（可选，当前只接收，不主动发）
const espClients = new Set();

// 广播给所有浏览器客户端
function broadcastBrowsers(msg) {
    const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
    browserClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(str);
        }
    });
}

// 解析 JSON 请求体（如果将来还想用 HTTP POST，可以保留）
app.use(bodyParser.json());

// （可选）保留 HTTP POST /data 接口，兼容以前的实现
app.post('/data', (req, res) => {
    const { roll, pitch, yaw } = req.body;
    if (roll !== undefined && pitch !== undefined && yaw !== undefined) {
        latestEuler = { roll, pitch, yaw };
        console.log('[HTTP] Received:', latestEuler);

        // 广播给所有浏览器 WebSocket 客户端
        broadcastBrowsers(JSON.stringify(latestEuler));

        res.status(200).send('OK');
    } else {
        res.status(400).send('Missing fields');
    }
});

// 心跳接口：Qt 后台线程定期轮询，确认服务器存活
app.get('/ping', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - SERVER_START) / 1000),
        espConnected,
        clients: browserClients.size
    });
});

// 历史数据接口：返回环形缓冲区中最近的记录
app.get('/history', (req, res) => {
    const parsed = parseInt(req.query.limit, 10);
    const limit = isNaN(parsed) ? 200 : Math.min(parsed, HISTORY_LIMIT);
    const data = historyBuffer.slice(-limit);
    res.json({ count: data.length, records: data });
});

// 提供静态网页文件
app.use(express.static('public'));

// 处理 HTTP -> WS 升级
server.on('upgrade', (req, socket, head) => {
    const pathname = url.parse(req.url).pathname;
    console.log('[UPGRADE] pathname =', pathname);

    // /esp 路径给 ESP32 使用
    if (pathname === '/esp') {
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.clientType = 'esp';
            wss.emit('connection', ws, req);
        });
    } else {
        // 其余路径（例如 / 或 /xxx）都当作浏览器客户端
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.clientType = 'browser';
            wss.emit('connection', ws, req);
        });
    }
});

// WebSocket 连接建立
wss.on('connection', (ws, req) => {
    const type = ws.clientType || 'unknown';
    console.log('WebSocket client connected, type =', type);

    if (type === 'browser') {
        // 浏览器连接：加入集合并发送当前最新值和 ESP 连接状态
        browserClients.add(ws);
        ws.send(JSON.stringify(latestEuler));
        ws.send(JSON.stringify({ type: 'esp_status', connected: espConnected }));

        ws.on('close', () => {
            browserClients.delete(ws);
            console.log('Browser client disconnected');
        });

    } else if (type === 'esp') {
        espClients.add(ws);
        espConnected = true;
        console.log('ESP32 client connected');
        broadcastBrowsers({ type: 'esp_status', connected: true });

        ws.on('message', (message) => {
            try {
                const text = message.toString();
                const data = JSON.parse(text);

                // RTT 测试 ping/pong 保持不变
                if (data.type === 'ping' && typeof data.tick === 'number') {
                    const pong = { type: 'pong', tick: data.tick };
                    ws.send(JSON.stringify(pong));
                    return;
                }

                // ★ 四元数 + 延迟
                if (data.type === 'quat') {
                    const { q0, q1, q2, q3, lat_es } = data;
                    if (
                        typeof q0 === 'number' &&
                        typeof q1 === 'number' &&
                        typeof q2 === 'number' &&
                        typeof q3 === 'number'
                    ) {
                        const serverTime = Date.now();
                        const latEs = typeof lat_es === 'number' ? lat_es : 0;
                        console.log('[ESP WS] Quat+lat:', { q0, q1, q2, q3 }, 'lat_es=', latEs);

                        pushHistory({ serverTime, type: 'quat', q0, q1, q2, q3, lat_es: latEs });

                        broadcastBrowsers({ type: 'quat', q0, q1, q2, q3, lat_es: latEs, serverTime });
                    } else {
                        console.warn('[ESP WS] invalid quat data:', data);
                    }
                    return;
                }

                // ★ 合并后的姿态+延迟消息
                if (data.type === 'euler') {
                    const { roll, pitch, yaw, lat_es } = data;
                    if (
                        typeof roll === 'number' &&
                        typeof pitch === 'number' &&
                        typeof yaw === 'number'
                    ) {
                        latestEuler = { roll, pitch, yaw };
                        const serverTime = Date.now();
                        const latEs = typeof lat_es === 'number' ? lat_es : 0;
                        console.log('[ESP WS] Euler+lat:', latestEuler, 'lat_es=', latEs);

                        pushHistory({ serverTime, type: 'euler', roll, pitch, yaw, lat_es: latEs });

                        broadcastBrowsers({ type: 'euler', roll, pitch, yaw, lat_es: latEs, serverTime });
                    }
                    return;
                }
                // 其他类型忽略
            } catch (err) {
                console.error('[ESP WS] Failed to parse message:', err);
            }
        });

        ws.on('close', () => {
            espClients.delete(ws);
            espConnected = espClients.size > 0;
            console.log('ESP32 client disconnected');
            broadcastBrowsers({ type: 'esp_status', connected: espConnected });
        });

    } else {
        // 未知类型，直接关闭
        console.warn('Unknown WS client type, closing');
        ws.close();
    }
});

server.listen(3000, '0.0.0.0', () => {
    console.log('Server running on port 3000');
});