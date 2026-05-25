const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ reply: 'Method Not Allowed' });
    }

    const { message, character, history, user } = req.body;

    if (!message) {
        return res.status(400).json({ reply: "消息内容不能为空" });
    }

    try {
        // 优先从 DEEPSEEK_API_KEY 读取，兼容旧的 ANTHROPIC_API_KEY
        const apiKey = process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY;
        
        if (!apiKey) {
            return res.status(500).json({ reply: "服务器未配置 API_KEY (请在环境变量中配置 DEEPSEEK_API_KEY)" });
        }

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

        // 智能判断 Header 格式
        // 1. 如果是直接调用 Anthropic 官方接口
        // 2. 或者 Key 是以 sk-ant- 开头的
        const isAnthropicDirect = endpoint.includes('anthropic.com');
        const isAnthropicKey = apiKey.startsWith('sk-ant-');
        
        if (isAnthropicDirect || (isAnthropicKey && !endpoint.includes('openrouter.ai'))) {
            headers["x-api-key"] = apiKey;
            headers["anthropic-version"] = "2023-06-01";
            console.log(`[API] Using Anthropic header format for endpoint: ${endpoint}`);
        } else {
            headers["Authorization"] = `Bearer ${apiKey}`;
            // 某些代理在请求 Claude 模型时仍需要 OpenAI 格式，这是最通用的
            console.log(`[API] Using Bearer header format for endpoint: ${endpoint}`);
        }

        let body;
        // 只有在直接调用 Anthropic 官方接口时才使用其特有的 body 格式
        if (isAnthropicDirect) {
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
            console.error('--- API Error Log ---');
            console.error('Endpoint:', endpoint);
            console.error('Status:', response.status);
            console.error('Body:', errorText);
            console.error('---------------------');
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
};
