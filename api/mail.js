const nodemailer = require('nodemailer');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: '仅支持 POST 请求' });

    const { type, content, user } = req.body;
    const mailUser = process.env.MAIL_USER;
    const mailPass = process.env.MAIL_PASS;

    console.log(`[Mail] 开始发送邮件流程... 用户: ${mailUser}`);

    if (!mailUser || !mailPass) {
        return res.status(500).json({ success: false, message: '环境变量 MAIL_USER 或 MAIL_PASS 未配置' });
    }

    // 尝试不同的配置组合
    const configs = [
        { host: 'smtp.qq.com', port: 465, secure: true }, // 默认配置
        { host: 'smtp.qq.com', port: 587, secure: false } // 备用配置
    ];

    let lastError = null;

    for (const config of configs) {
        try {
            console.log(`[Mail] 尝试配置: ${config.host}:${config.port} (secure: ${config.secure})`);
            const transporter = nodemailer.createTransport({
                ...config,
                auth: { user: mailUser, pass: mailPass },
                connectionTimeout: 5000, // 5秒连接超时
            });

            // 验证连接
            await transporter.verify();
            console.log(`[Mail] ${config.port} 端口连接成功，准备发送...`);

            const mailOptions = {
                from: `"网站反馈" <${mailUser}>`,
                to: mailUser,
                subject: `新反馈: ${user?.nickname || '未知用户'}`,
                html: `<div style="padding:20px;border:1px solid #eee;">
                        <h3>收到新反馈</h3>
                        <p>内容: ${content}</p>
                        <p>发送人: ${mailUser}</p>
                       </div>`
            };

            await transporter.sendMail(mailOptions);
            console.log(`[Mail] 邮件发送成功！`);
            return res.status(200).json({ success: true, message: '邮件发送成功' });

        } catch (err) {
            console.error(`[Mail] ${config.port} 端口失败:`, err.message);
            lastError = err;
            continue; // 尝试下一个配置
        }
    }

    // 如果所有尝试都失败
    return res.status(500).json({ 
        success: false, 
        message: '邮件发送失败', 
        debug: lastError.message,
        code: lastError.code
    });
};
