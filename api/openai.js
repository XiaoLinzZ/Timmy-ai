const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

module.exports = async (req, res) => {
    // 允许跨域
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(200).json({ message: "OpenAI Compatible API Proxy is running" });
    }

    const { messages, model, stream } = req.body;

    try {
        const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY;
        const proxyBaseUrl = process.env.API_BASE_URL || (process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : (process.env.ANTHROPIC_API_KEY ? "https://api.anthropic.com" : "https://api.deepseek.com"));
        const requestModel = process.env.DEEPSEEK_MODEL || (process.env.ANTHROPIC_API_KEY ? "claude-3-5-sonnet-20240620" : "deepseek-chat");

        if (!apiKey) {
            return res.status(500).json({ error: "API_KEY not configured" });
        }

        let endpoint = proxyBaseUrl;
        const headers = {
            "Content-Type": "application/json"
        };

        // 智能判断 Header 格式
        const isAnthropicDirect = endpoint.includes('anthropic.com');
        const isAnthropicKey = apiKey.startsWith('sk-ant-');

        if (isAnthropicDirect || (isAnthropicKey && !endpoint.includes('openrouter.ai'))) {
            headers["x-api-key"] = apiKey;
            headers["anthropic-version"] = "2023-06-01";
            endpoint = `${endpoint.replace(/\/$/, '')}/v1/messages`;
        } else {
            headers["Authorization"] = `Bearer ${apiKey}`;
            endpoint = endpoint.replace(/\/v1$/, '') + '/v1/chat/completions';
        }

        let body;
        if (isAnthropicDirect) {
            body = JSON.stringify({
                model: model || requestModel,
                max_tokens: 1024,
                messages: messages.filter(m => m.role !== 'system'),
                system: messages.find(m => m.role === 'system')?.content || "你是一个真实的人类伴侣，正在微信上聊天。",
                stream: stream || false
            });
        } else {
            body = JSON.stringify({
                model: model || requestModel,
                messages: messages,
                max_tokens: 1024,
                stream: stream || false
            });
        }

        const response = await fetch(endpoint, {
            method: "POST",
            headers: headers,
            body: body
        });

        const data = await response.json();
        return res.status(response.status).json(data);

    } catch (error) {
        console.error('Proxy Error:', error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};
