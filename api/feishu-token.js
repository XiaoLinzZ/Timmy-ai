const fetch = require('node-fetch');

// 飞书 Token 缓存 (注意：Vercel Serverless 环境下缓存可能不可靠，但单次请求内有效)
let feishuTokenCache = {
    token: null,
    expireTime: 0
};

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
        return res.status(500).json({ error: 'FEISHU_APP_ID or FEISHU_APP_SECRET is not configured' });
    }

    // 检查缓存是否有效
    if (feishuTokenCache.token && Date.now() < feishuTokenCache.expireTime) {
        return res.json({ tenant_access_token: feishuTokenCache.token });
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
            feishuTokenCache.expireTime = Date.now() + (data.expire - 300) * 1000;
            return res.json({ tenant_access_token: data.tenant_access_token });
        } else {
            return res.status(500).json({ error: `Feishu API error: ${data.msg} (code: ${data.code})` });
        }
    } catch (error) {
        console.error('Error fetching Feishu token:', error);
        return res.status(500).json({ error: error.message });
    }
};
