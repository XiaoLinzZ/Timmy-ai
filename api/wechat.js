const crypto = require('crypto');
const xml2js = require('xml2js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

module.exports = async (req, res) => {
    const { method, query } = req;
    const token = (process.env.WECHAT_TOKEN || '').trim();

    console.log(`[WeChat] ${method} request received`);

    if (method === 'GET') {
        const { signature, timestamp, nonce, echostr } = query;
        
        // 基础验证，方便直接浏览器访问测试
        if (!signature || !timestamp || !nonce) {
            return res.status(200).send(`WeChat API is running. Token configured: ${!!token}`);
        }

        if (!token) {
            console.error('[WeChat] WECHAT_TOKEN is not configured in environment variables');
            return res.status(500).send('Server configuration error: Missing token');
        }

        const array = [token, timestamp, nonce].sort();
        const tempStr = array.join('');
        const hashCode = crypto.createHash('sha1').update(tempStr).digest('hex');

        if (hashCode === signature) {
            console.log('[WeChat] Signature verification passed');
            return res.send(echostr);
        } else {
            console.error('[WeChat] Signature verification failed');
            console.error(`Expected: ${signature}, Calculated: ${hashCode}`);
            return res.status(401).send('Invalid signature');
        }
    }

    if (req.method === 'POST') {
        let xmlData = '';
        
        // Vercel raw body handling
        if (req.body && typeof req.body === 'string') {
            xmlData = req.body;
        } else {
            // Read from stream if not already parsed
            const buffers = [];
            for await (const chunk of req) {
                buffers.push(chunk);
            }
            xmlData = Buffer.concat(buffers).toString();
        }

        try {
            const result = await xml2js.parseStringPromise(xmlData, { explicitArray: false });
            const msg = result.xml;

            if (msg.MsgType === 'text') {
                const aiReply = await getAIReply(msg.Content);
                const replyXml = `
                    <xml>
                        <ToUserName><![CDATA[${msg.FromUserName}]]></ToUserName>
                        <FromUserName><![CDATA[${msg.ToUserName}]]></FromUserName>
                        <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
                        <MsgType><![CDATA[text]]></MsgType>
                        <Content><![CDATA[${aiReply}]]></Content>
                    </xml>
                `;
                res.setHeader('Content-Type', 'application/xml');
                return res.status(200).send(replyXml);
            }
            return res.send('success');
        } catch (error) {
            console.error('Post Error:', error);
            return res.send('success');
        }
    }
};

async function getAIReply(message) {
    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY;
    const proxyBaseUrl = process.env.API_BASE_URL || (process.env.ANTHROPIC_API_KEY ? "https://api.anthropic.com" : "https://api.deepseek.com");
    const requestModel = process.env.DEEPSEEK_MODEL || (process.env.ANTHROPIC_API_KEY ? "claude-3-5-sonnet-20240620" : "deepseek-chat");
    
    let endpoint = proxyBaseUrl;
    
    // Handle different API formats
    const isAnthropic = endpoint.includes('anthropic.com');
    const isOpenRouter = endpoint.includes('openrouter.ai');

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
            const errorData = await response.text();
            console.error('[WeChat] AI API Error:', response.status, errorData);
            return "抱歉哈，我现在手头有点事，晚点回你。";
        }

        const data = await response.json();
        
        if (isAnthropic) {
            return data.content?.[0]?.text || "嗯？刚才没听清，再说一遍？";
        } else {
            return data.choices?.[0]?.message?.content || "嗯？刚才没听清，再说一遍？";
        }
    } catch (error) {
        console.error('[WeChat] Network Error:', error);
        return "网络好像有点调皮，等我一下哦。";
    }
}
