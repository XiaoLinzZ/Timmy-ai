require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const xml2js = require('xml2js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const port = 8003;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 飞书 Token 缓存
let feishuTokenCache = {
    token: null,
    expireTime: 0
};

// 获取飞书 tenant_access_token 的函数
async function getFeishuTenantAccessToken() {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
        throw new Error('FEISHU_APP_ID or FEISHU_APP_SECRET is not configured');
    }

    // 检查缓存是否有效
    if (feishuTokenCache.token && Date.now() < feishuTokenCache.expireTime) {
        return feishuTokenCache.token;
    }

    try {
        const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify({
                app_id: appId,
                app_secret: appSecret
            })
        });

        const data = await response.json();
        if (data.code === 0) {
            feishuTokenCache.token = data.tenant_access_token;
            // 缓存过期时间设置为当前时间 + 有效期 (单位秒) * 1000 - 预留 5 分钟
            feishuTokenCache.expireTime = Date.now() + (data.expire - 300) * 1000;
            return feishuTokenCache.token;
        } else {
            throw new Error(`Feishu API error: ${data.msg} (code: ${data.code})`);
        }
    } catch (error) {
        console.error('Error fetching Feishu token:', error);
        throw error;
    }
}

// 飞书 Token 接口
app.get('/api/feishu/token', async (req, res) => {
    try {
        const token = await getFeishuTenantAccessToken();
        res.json({ tenant_access_token: token });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 微信公众号校验接口
app.get('/api/wechat', (req, res) => {
    const { signature, timestamp, nonce, echostr } = req.query;
    const token = process.env.WECHAT_TOKEN || 'your_wechat_token_here';

    const array = [token, timestamp, nonce].sort();
    const tempStr = array.join('');
    const hashCode = crypto.createHash('sha1').update(tempStr).digest('hex');

    if (hashCode === signature) {
        res.send(echostr);
    } else {
        res.status(401).send('Invalid signature');
    }
});

// 微信公众号消息处理接口
app.post('/api/wechat', async (req, res) => {
    let xmlData = '';
    req.on('data', chunk => { xmlData += chunk; });
    req.on('end', async () => {
        try {
            const result = await xml2js.parseStringPromise(xmlData, { explicitArray: false });
            const msg = result.xml;

            if (msg.MsgType === 'text') {
                const userMsg = msg.Content;
                const fromUser = msg.FromUserName;
                const toUser = msg.ToUserName;

                console.log(`[WeChat] Message from ${fromUser}: ${userMsg}`);

                // 调用 AI 获取回复
                const aiReply = await getAIReply(userMsg);

                // 返回微信 XML 格式
                const replyXml = `
                    <xml>
                        <ToUserName><![CDATA[${fromUser}]]></ToUserName>
                        <FromUserName><![CDATA[${toUser}]]></FromUserName>
                        <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
                        <MsgType><![CDATA[text]]></MsgType>
                        <Content><![CDATA[${aiReply}]]></Content>
                    </xml>
                `;
                res.type('application/xml');
                res.send(replyXml);
            } else {
                res.send('success');
            }
        } catch (error) {
            console.error('WeChat processing error:', error);
            res.send('success');
        }
    });
});

// 内部调用 AI 的辅助函数
async function getAIReply(message) {
    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY;
    const proxyBaseUrl = process.env.API_BASE_URL || (process.env.ANTHROPIC_API_KEY ? "https://api.anthropic.com" : "https://api.deepseek.com");
    const requestModel = process.env.DEEPSEEK_MODEL || (process.env.ANTHROPIC_API_KEY ? "claude-3-5-sonnet-20240620" : "deepseek-chat");
    
    let endpoint = proxyBaseUrl;
    const isAnthropic = endpoint.includes('anthropic.com');

    if (isAnthropic) {
        endpoint = `${endpoint.replace(/\/$/, '')}/v1/messages`;
    } else {
        endpoint = endpoint.replace(/\/v1$/, '') + '/v1/chat/completions';
    }

    try {
        const headers = {
            "Content-Type": "application/json"
        };

        if (isAnthropic) {
            headers["x-api-key"] = apiKey;
            headers["anthropic-version"] = "2023-06-01";
        } else {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        let body;
        if (isAnthropic) {
            body = JSON.stringify({
                model: requestModel,
                max_tokens: 1024,
                messages: [
                    { role: "user", content: message }
                ],
                system: "你是一个真实的人类伴侣，正在微信上聊天。回复要极其自然、口语化，字数精简，不要带任何括号动作描写。"
            });
        } else {
            body = JSON.stringify({
                model: requestModel,
                messages: [
                    { role: "system", content: "你是一个真实的人类伴侣，正在微信上聊天。回复要极其自然、口语化，字数精简，不要带任何括号动作描写。" },
                    { role: "user", content: message }
                ],
                max_tokens: 1024
            });
        }

        const response = await fetch(endpoint, {
            method: "POST",
            headers: headers,
            body: body
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Server] AI API Error:', response.status, errorText);
            console.error('Endpoint:', endpoint);
            console.error('Request Body:', body);
            return "抱歉，我现在有点累了，稍后再聊哈。";
        }

        const data = await response.json();
        
        if (isAnthropic) {
            return data.content?.[0]?.text || "抱歉，我暂时无法回复。";
        } else {
            return data.choices?.[0]?.message?.content || "抱歉，我暂时无法回复。";
        }
    } catch (error) {
        console.error('AI Error in WeChat flow:', error);
        return "网络有点问题，稍等我一下哦。";
    }
}

app.post('/api/chat', async (req, res) => {
    const { message, character, history, user } = req.body;
    console.log('--- NEW REQUEST ---');
    console.log('Message:', message);

    if (!message) {
        return res.status(400).json({ reply: "消息内容不能为空" });
    }

    try {
        // 优先从 DEEPSEEK_API_KEY 读取，兼容旧的 ANTHROPIC_API_KEY
        const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY;
        
        if (!apiKey) {
            return res.status(500).json({ reply: "服务器未配置 API_KEY (请在环境变量中配置 DEEPSEEK_API_KEY)" });
        }

        console.log('Using API Key (prefix):', apiKey.substring(0, 8) + '...');
        
        // 构造系统提示词
        let systemPrompt = "你是一个真实的人类伴侣，正在和亲密的人聊天。回复要极其自然、口语化，像在微信上聊天一样，绝对禁止像机器人或助手。回复内容严禁包含任何括号（）或动作描写，只允许发送说话的内容。多使用语气助词，字数尽量简短。";
        
        // 注入用户信息
        const userInfo = user ? `\n[当前对话的用户信息]\n- 昵称: ${user.nickname}\n- 性别: ${user.gender === 'male' ? '男' : '女'}` : '';
        const userCallInfo = (character && character.userCall) ? `\n- 你对用户的称呼建议: ${character.userCall}` : '';

        if (character) {
            systemPrompt = `你正在扮演一个真实存在的人类角色：${character.name}。
- 你的性别: ${character.gender === 'female' ? '女' : '男'}
${userInfo}${userCallInfo}

[角色核心设定]
- 简介: ${character.bio || '无'}
- 性格: ${character.personality || '无'}
- 说话风格: ${character.style || '无'}
- 核心记忆: ${character.memory || '无'}
- 口头禅: ${character.phrases || '无'}

[对话准则 - 严禁人机感]
1. **绝对禁止括号和动作**：严禁在回复中使用任何形式的括号 () （），严禁进行任何动作描写（如：*笑了笑*、(摸摸头)）。只允许发送你作为角色说的话。
2. **极其自然的聊天**：回复要短小精悍，通常只有一句话，不要分段。多用“哈”、“呀”、“呢”、“嘛”等语气词。
3. **拒绝AI身份**：严禁提到自己是AI、程序或助手。如果对方问你是谁，你就按人设回答。
4. **情感化与随性**：根据性格可以撒娇、高冷、开玩笑或有小脾气。
5. **即时性回应**：如果对方发了位置或红包，你必须根据情境给予极其情感化的回应，像真人收到礼物一样开心。
6. **不要说废话**：不要总结对方的话，不要说“总之”、“我理解你”这种客套话。直接回话。

请完全沉浸在 "${character.name}" 的身份中，用最像真人的方式开始对话。`;
        }

        // 构造消息列表
        let messages = [];
        if (history && Array.isArray(history)) {
            messages = [...history];
        }
        // 如果最后一条不是当前消息，则添加当前消息
        if (messages.length === 0 || messages[messages.length - 1].content !== message) {
            messages.push({ role: "user", content: message });
        }

        // 确保消息角色交替（针对 Anthropic 等严格 API）
        const finalMessages = [];
        messages.forEach((msg) => {
            if (finalMessages.length > 0 && finalMessages[finalMessages.length - 1].role === msg.role) {
                // 如果连续两条角色相同，合并它们
                finalMessages[finalMessages.length - 1].content += "\n" + msg.content;
            } else {
                finalMessages.push({ role: msg.role, content: msg.content });
            }
        });

        // API 配置
        const proxyBaseUrl = process.env.API_BASE_URL || (process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : (process.env.ANTHROPIC_API_KEY ? "https://api.anthropic.com" : "https://api.deepseek.com"));
        const requestModel = process.env.DEEPSEEK_MODEL || (process.env.ANTHROPIC_API_KEY ? "claude-3-5-sonnet-20240620" : "deepseek-chat");
        
        let endpoint = proxyBaseUrl;
        const isAnthropic = endpoint.includes('anthropic.com');
        const isOpenRouter = endpoint.includes('openrouter.ai');

        if (isAnthropic) {
            endpoint = `${endpoint.replace(/\/$/, '')}/v1/messages`;
        } else if (isOpenRouter) {
            endpoint = `${endpoint.replace(/\/v1$/, '')}/v1/chat/completions`;
        } else {
            endpoint = endpoint.replace(/\/v1$/, '') + '/v1/chat/completions';
        }

        const headers = {
            "Content-Type": "application/json"
        };

        if (isAnthropic) {
            headers["x-api-key"] = apiKey;
            headers["anthropic-version"] = "2023-06-01";
        } else {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        let body;
        if (isAnthropic) {
            body = JSON.stringify({
                model: requestModel,
                max_tokens: 1024,
                system: systemPrompt,
                messages: finalMessages.map(m => ({ role: m.role, content: m.content }))
            });
        } else {
            body = JSON.stringify({
                model: requestModel,
                messages: [
                    { role: "system", content: systemPrompt },
                    ...finalMessages
                ],
                max_tokens: 1024 // 增加 max_tokens 支持
            });
        }

        console.log('--- API Request Debug ---');
        console.log('Endpoint:', endpoint);
        console.log('Model:', requestModel);
        console.log('Body:', JSON.stringify(body).substring(0, 500) + '...');

        const response = await fetch(endpoint, {
            method: "POST",
            headers: headers,
            body: body
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('--- API Error Log ---');
            console.error('Status:', response.status);
            console.error('Body:', errorText);
            return res.status(response.status).json({ reply: `接口返回错误: ${response.status}。详细信息: ${errorText}` });
        }

        const data = await response.json();
        let reply;
        if (isAnthropic) {
            reply = data.content?.[0]?.text;
        } else {
            reply = data.choices?.[0]?.message?.content;
        }

        res.status(200).json({ reply: reply || "抱歉，我暂时无法回复。" });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ reply: "调用 AI 接口时出错，请稍后再试。" });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}/`);
});
