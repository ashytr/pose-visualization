const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const url = require('url');

const app = express();
const server = http.createServer(app);


// 用 noServer 模式，自己处理 upgrade 以区分路径
const wss = new WebSocket.Server({ noServer: true });

// 存储最新的欧拉角数据
let latestEuler = { roll: 0, pitch: 0, yaw: 0 };

// 存储浏览器 WS 客户端（用来可视化）
const browserClients = new Set();
// 存储 ESP32 WS 客户端（可选，当前只接收，不主动发）
const espClients = new Set();

// 解析 JSON 请求体（如果将来还想用 HTTP POST，可以保留）
app.use(bodyParser.json());

// （可选）保留 HTTP POST /data 接口，兼容以前的实现
app.post('/data', (req, res) => {
    const { roll, pitch, yaw } = req.body;
    if (roll !== undefined && pitch !== undefined && yaw !== undefined) {
        latestEuler = { roll, pitch, yaw };
        console.log('[HTTP] Received:', latestEuler);

        // 广播给所有浏览器 WebSocket 客户端
        const msg = JSON.stringify(latestEuler);
        browserClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(msg);
            }
        });

        res.status(200).send('OK');
    } else {
        res.status(400).send('Missing fields');
    }
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
        // 浏览器连接：加入集合并发送当前最新值
        browserClients.add(ws);
        ws.send(JSON.stringify(latestEuler));

        ws.on('close', () => {
            browserClients.delete(ws);
            console.log('Browser client disconnected');
        });

    } else if (type === 'esp') {
        espClients.add(ws);
        console.log('ESP32 client connected');

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
                        console.log('[ESP WS] Quat+lat:', { q0, q1, q2, q3 }, 'lat_es=', lat_es);

                        const msg = JSON.stringify({
                            type: 'quat',
                            q0, q1, q2, q3,
                            lat_es: typeof lat_es === 'number' ? lat_es : 0,
                            serverTime: Date.now()
                        });

                        browserClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(msg);
                            }
                        });
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
                        console.log('[ESP WS] Euler+lat:', latestEuler, 'lat_es=', lat_es);

                        const msg = JSON.stringify({
                            type: 'euler',
                            roll,
                            pitch,
                            yaw,
                            lat_es: typeof lat_es === 'number' ? lat_es : 0,
                            serverTime: Date.now()
                        });

                        browserClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(msg);
                            }
                        });
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
            console.log('ESP32 client disconnected');
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