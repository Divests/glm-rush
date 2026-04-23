// ==UserScript==
// @name         智谱 GLM Coding 抢购助手 v4.0
// @namespace    http://tampermonkey.net/
// @version      4.9
// @description  并发重试 + 自适应间隔 + 反检测 + check校验 + 弹窗恢复 + 定时触发 + 配置持久化
// @author       Assistant
// @match        *://www.bigmodel.cn/*
// @match        *://bigmodel.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════
    //  配置 (localStorage 持久化)
    // ═══════════════════════════════════════════
    const DEFAULT_CFG = {
        concurrency: 5,       // 并发路数 (普通模式)
        turboConcurrency: 10, // 极速模式并发路数
        turboSec: 5,          // 极速模式持续秒数
        maxRetry: 2000,       // 最大重试次数
        burstCount: 20,       // 前N次零延迟爆发
        fastDelay: 30,        // 爆发后的快速间隔
        slowDelay: 100,       // 后期随机间隔中值
        jitter: 0.3,          // 间隔随机抖动 ±30%
        recoveryMax: 3,       // 弹窗恢复最大次数
        logMax: 100,          // 日志条数上限
        rushTime: '10:00:00',     // 每天抢购时间 (北京时间)
        PREVIEW: '/api/biz/pay/preview',
        CHECK: '/api/biz/pay/check',
    };

    function loadCfg() {
        try {
            const saved = JSON.parse(localStorage.getItem('glm_rush_cfg'));
            return { ...DEFAULT_CFG, ...saved };
        } catch { return { ...DEFAULT_CFG }; }
    }
    function saveCfg(cfg) {
        const { PREVIEW, CHECK, ...save } = cfg;
        localStorage.setItem('glm_rush_cfg', JSON.stringify(save));
    }

    const CFG = loadCfg();

    // ═══════════════════════════════════════════
    //  状态 (不可变更新)
    // ═══════════════════════════════════════════
    let state = {
        status: 'idle',      // idle | retrying | success | failed
        count: 0,
        bizId: null,
        captured: null,      // 捕获的请求参数
        cache: null,         // 成功响应缓存
        lastSuccess: null,
        proactive: false,
        timerId: null,
        logs: [],
        stats: { total: 0, success: 0, errors: 0, avgMs: 0, startTime: 0 },
    };

    function setState(patch) {
        state = { ...state, ...patch };
        refreshUI();
    }

    // 恢复上次捕获的请求
    try {
        const saved = sessionStorage.getItem('glm_rush_captured');
        if (saved) state.captured = JSON.parse(saved);
    } catch {}

    let stopRequested = false;
    let recovering = false;
    let recoveryAttempts = 0;
    let _shadowRef = null;

    // ═══════════════════════════════════════════
    //  工具
    // ═══════════════════════════════════════════
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const rand = (min, max) => min + Math.random() * (max - min);
    const jitteredDelay = base => Math.round(base * (1 + (Math.random() * 2 - 1) * CFG.jitter));

    // ═══════════════════════════════════════════
    //  验证码 (队列 + 后台预热)
    // ═══════════════════════════════════════════
    const CAPTCHA_APP_ID = '196026326';
    let captchaQueue = [];          // { ticket, randstr, ts }
    let captchaSolving = false;     // 是否正在解验证码
    const CAPTCHA_VALID_MS = 4 * 60 * 1000; // 4分钟有效期（留1分钟余量）

    async function ensureCaptchaSDK() {
        if (typeof TencentCaptcha === 'undefined') {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://turing.captcha.gtimg.com/turing.js';
                s.onload = resolve;
                s.onerror = () => reject(new Error('验证码SDK加载失败'));
                document.head.appendChild(s);
            });
        }
    }

    async function doCaptcha() {
        await ensureCaptchaSDK();
        return new Promise(resolve => {
            try {
                const captcha = new TencentCaptcha(CAPTCHA_APP_ID, function(res) {
                    if (res.ret === 0) {
                        resolve({ ticket: res.ticket, randstr: res.randstr });
                    } else {
                        resolve({ ticket: '', randstr: '' });
                    }
                });
                captcha.show();
            } catch (e) {
                resolve({ ticket: '', randstr: '' });
            }
        });
    }

    // 取一个有效的 ticket（过期自动丢弃）
    function dequeueCaptcha() {
        const now = Date.now();
        while (captchaQueue.length > 0) {
            const item = captchaQueue[0];
            if (now - item.ts > CAPTCHA_VALID_MS) {
                captchaQueue.shift();
                continue;
            }
            return captchaQueue.shift();
        }
        return null;
    }

    // 后台弹验证码（不阻塞重试循环）
    function backgroundSolveCaptcha() {
        if (captchaSolving) return;
        captchaSolving = true;
        doCaptcha().then(result => {
            captchaSolving = false;
            if (result.ticket) {
                captchaQueue.push({ ...result, ts: Date.now() });
                log(`验证码完成, 队列中有 ${captchaQueue.length} 个ticket`);
            }
        }).catch(() => { captchaSolving = false; });
    }

    // 定时预热验证码（抢购前 5 分钟开始，每 30 秒弹一次）
    let preheatTimer = null;
    function startCaptchaPreheat() {
        if (preheatTimer) return;
        log('验证码预热启动 (每30秒弹一次)');
        preheatTimer = setInterval(() => {
            if (captchaSolving) return;
            if (captchaQueue.length >= 3) return; // 队列满了不弹
            log('预热验证码... 请快速完成');
            backgroundSolveCaptcha();
        }, 30000);
    }

    function stopCaptchaPreheat() {
        if (preheatTimer) { clearInterval(preheatTimer); preheatTimer = null; }
    }

    function getDelay(attempt) {
        if (attempt <= CFG.burstCount) return 0;
        if (attempt <= 50) return jitteredDelay(CFG.fastDelay);
        return jitteredDelay(CFG.slowDelay);
    }

    function log(msg, level = 'info') {
        const entry = { ts: ts(), msg, level };
        const logs = [...state.logs, entry];
        if (logs.length > CFG.logMax) logs.splice(0, logs.length - CFG.logMax);
        state = { ...state, logs };
        console.log(`[GLM] ${msg}`);
        appendLogDOM(entry);
    }

    function extractHeaders(h) {
        const o = {};
        if (!h) return o;
        if (h instanceof Headers) h.forEach((v, k) => (o[k] = v));
        else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k] = v));
        else Object.entries(h).forEach(([k, v]) => (o[k] = v));
        return o;
    }

    // ═══════════════════════════════════════════
    //  JSON.parse 定向拦截 (仅修改特定数据结构)
    // ═══════════════════════════════════════════
    const _parse = JSON.parse;

    function patchSoldOut(obj, visited = new WeakSet()) {
        if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
        visited.add(obj);
        if (obj.isSoldOut === true) obj.isSoldOut = false;
        if (obj.soldOut === true) obj.soldOut = false;
        if (obj.isServerBusy === true) obj.isServerBusy = false;
        if (obj.disabled === true && (obj.price !== undefined || obj.productId || obj.title)) obj.disabled = false;
        if (obj.stock === 0) obj.stock = 999;
        for (const k of Object.keys(obj)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (obj[k] && typeof obj[k] === 'object') patchSoldOut(obj[k], visited);
        }
    }

    // 全局 patch: 页面加载时也需要解除售罄状态，否则按钮不可点击
    JSON.parse = function (text, reviver) {
        const result = _parse(text, reviver);
        try { patchSoldOut(result); } catch {}
        return result;
    };
    Object.defineProperty(JSON.parse, 'toString', { value: () => 'function parse() { [native code] }' });

    // ═══════════════════════════════════════════
    //  核心: 并发重试引擎
    // ═══════════════════════════════════════════
    const _fetch = window.fetch;
    let _retryLock = null;

    async function singleAttempt(url, opts, attemptNum) {
        try {
            // 请求指纹随机化 — 每次请求看起来不一样，降低被识别为脚本的概率
            const randHeaders = { ...opts.headers };
            randHeaders['X-Request-Id'] = Math.random().toString(36).slice(2, 15);
            randHeaders['X-Timestamp'] = String(Date.now());
            // 随机 Accept-Language 权重，让每次请求指纹不同
            const q = (0.5 + Math.random() * 0.5).toFixed(1);
            randHeaders['Accept-Language'] = `zh-CN,zh;q=${q},en;q=${(q * 0.7).toFixed(1)}`;

            // 重放时去掉一次性验证码凭据，避免用旧 ticket 被拒
            let reqBody = opts.body;
            if (reqBody && typeof reqBody === 'string') {
                try {
                    const bodyObj = _parse(reqBody);
                    if (bodyObj.ticket || bodyObj.randstr) {
                        const clean = { ...bodyObj };
                        delete clean.ticket;
                        delete clean.randstr;
                        reqBody = JSON.stringify(clean);
                    }
                } catch {}
            }

            // 如果队列里有有效 ticket，带上
            const cachedTicket = dequeueCaptcha();
            if (cachedTicket) {
                try {
                    const bodyObj = _parse(reqBody || '{}');
                    reqBody = JSON.stringify({ ...bodyObj, ticket: cachedTicket.ticket, randstr: cachedTicket.randstr });
                } catch {}
            }

            const resp = await _fetch(url, { ...opts, body: reqBody, headers: randHeaders, credentials: 'include', priority: 'high' });

            // HTTP 状态码检测
            if (resp.status === 401 || resp.status === 403) {
                return { ok: false, reason: `HTTP ${resp.status} 会话过期`, attempt: attemptNum };
            }
            if (resp.status === 429) {
                return { ok: false, reason: '429 限流', attempt: attemptNum };
            }

            const text = await resp.text();
            let data;
            try { data = _parse(text); } catch { data = null; }

            if (data && data.code === 200 && data.data && data.data.bizId) {
                const bizId = data.data.bizId;

                // check 校验（异步，不阻塞其他并发请求）
                try {
                    const checkUrl = `${location.origin}${CFG.CHECK}?bizId=${encodeURIComponent(bizId)}`;
                    const checkResp = await _fetch(checkUrl, { credentials: 'include' });
                    const checkText = await checkResp.text();
                    let checkData;
                    try { checkData = _parse(checkText); } catch { checkData = null; }

                    if (checkData && checkData.data === 'EXPIRE') {
                        return { ok: false, reason: 'EXPIRE', attempt: attemptNum };
                    }

                    // 通过!
                    return { ok: true, text, data, bizId, status: resp.status, attempt: attemptNum };
                } catch (e) {
                    // check 失败不丢弃 bizId，直接返回成功（让后续流程处理）
                    return { ok: true, text, data, bizId, status: resp.status, attempt: attemptNum };
                }
            }

            // 需要验证码 → 触发验证码流程
            const msg = (data && data.msg) || '';
            if (data && (msg.includes('验证') || msg.includes('安全') || msg.includes('captcha') || msg.includes('ticket'))) {
                return { ok: false, reason: '需要验证码', needCaptcha: true, attempt: attemptNum };
            }

            const reason = !data ? '非JSON'
                : data.code === 555 ? '系统繁忙'
                : (data.data && data.data.bizId === null) ? '售罄'
                : `code=${data.code}`;
            return { ok: false, reason, attempt: attemptNum };
        } catch (e) {
            if (e.name === 'AbortError') return { ok: false, reason: '已取消', attempt: attemptNum };
            return { ok: false, reason: `网络: ${e.message}`, attempt: attemptNum };
        }
    }

    async function retry(url, rawOpts) {
        if (_retryLock) {
            log('合并到当前重试...');
            return _retryLock;
        }

        stopRequested = false;
        const { signal, ...opts } = rawOpts || {};

        _retryLock = (async () => {
            setState({ status: 'retrying', count: 0, stats: { ...state.stats, startTime: performance.now() } });

            let totalAttempt = 0;
            let consecutiveNetworkErrors = 0;
            let throttleCount = 0;
            let consecutiveSoldOut = 0;
            let adaptiveConcurrency = CFG.concurrency; // 自适应并发数
            let lastBatchReasons = []; // 上一批失败原因

            // ═══ 持续补充模式 ═══
            // 保持固定数量的请求在飞，一个返回就补一个，不浪费任何时间
            const maxInFlight = CFG.turboConcurrency; // 最大在飞请求数
            let inFlight = 0;       // 当前在飞数量
            let settled = false;    // 是否已成功
            let winnerResult = null;

            const enqueue = () => {
                if (settled || stopRequested || totalAttempt >= CFG.maxRetry) return;
                if (inFlight >= maxInFlight) return;

                totalAttempt++;
                inFlight++;

                // 错开请求：在极速窗口内，每个请求延迟 0~10ms 随机间隔
                const stagger = (performance.now() - state.stats.startTime < CFG.turboSec * 1000)
                    ? Math.random() * 10 : 0;

                setTimeout(() => {
                    if (settled || stopRequested) { inFlight--; return; }
                    singleAttempt(url, { ...opts }, totalAttempt).then(result => {
                        inFlight--;
                        if (settled) return;

                        if (result.ok) {
                            // 成功！
                            settled = true;
                            winnerResult = result;
                        } else {
                            // 分析失败原因
                            lastBatchReasons.push(result.reason || '未知');

                            // 触发验证码
                            if (result.needCaptcha) {
                                backgroundSolveCaptcha();
                            }

                            // 自适应并发调整
                            if (result.reason && result.reason.includes('429')) {
                                throttleCount++;
                                adaptiveConcurrency = Math.max(2, adaptiveConcurrency - 5);
                            } else if (result.reason === '售罄' || result.reason === '系统繁忙') {
                                // 服务器正常响应，可以加码
                                throttleCount = 0;
                                adaptiveConcurrency = Math.min(maxInFlight, adaptiveConcurrency + 1);
                            }

                            // 会话过期
                            if (result.reason && result.reason.includes('会话过期')) {
                                log('会话已过期, 请重新登录!', 'error');
                                setState({ status: 'failed' });
                                stopRequested = true;
                                return;
                            }
                        }

                        // 补充一个新请求（持续补充核心）
                        enqueue();
                    }).catch(() => { inFlight--; enqueue(); });

                    setState({ count: totalAttempt });
                }, stagger);
            };

            // 初始填满：一次性发射 maxInFlight 个请求
            for (let i = 0; i < maxInFlight; i++) {
                enqueue();
            }

            // ═══ 主循环：等待结果 + 定期分析 ═══
            while (!settled && !stopRequested && totalAttempt < CFG.maxRetry) {
                await sleep(100); // 每 100ms 检查一次

                // 定期分析失败原因
                if (lastBatchReasons.length >= 20) {
                    const reasons = lastBatchReasons.splice(0, 20); // 取出最近 20 个

                    // 连续网络错误
                    const networkErrors = reasons.filter(r => r.startsWith('网络')).length;
                    if (networkErrors >= 15) {
                        consecutiveNetworkErrors++;
                        if (consecutiveNetworkErrors >= 3) {
                            log('网络异常, 暂停3秒...');
                            await sleep(3000);
                            consecutiveNetworkErrors = 0;
                        }
                    } else {
                        consecutiveNetworkErrors = 0;
                    }

                    // 限流退避
                    if (reasons.some(r => r.includes('429') || r.includes('限流'))) {
                        const backoff = Math.min(2000 * (2 ** Math.min(throttleCount, 4)), 16000);
                        log(`限流, 退避${backoff}ms... (并发降至 ${adaptiveConcurrency})`, 'warn');
                        await sleep(backoff);
                    }

                    // 售罄降速（20秒后检测）
                    const elapsedSec = (performance.now() - state.stats.startTime) / 1000;
                    if (elapsedSec > 20 && reasons.every(r => r === '售罄')) {
                        consecutiveSoldOut++;
                        if (consecutiveSoldOut >= 10) {
                            if (consecutiveSoldOut === 10) log('连续售罄, 可能已抢完, 降速...');
                            await sleep(2000);
                        }
                    } else {
                        consecutiveSoldOut = 0;
                    }

                    // 验证码触发
                    const captchaCount = reasons.filter(r => r === '需要验证码').length;
                    if (captchaCount > 10) {
                        log(`${captchaCount}/20 需要验证码, 并发降至 ${adaptiveConcurrency}`, 'warn');
                        adaptiveConcurrency = Math.max(2, Math.floor(adaptiveConcurrency / 2));
                    }

                    // 日志
                    const sec = elapsedSec.toFixed(0);
                    log(`#${totalAttempt} ${reasons[0]} 并发:${adaptiveConcurrency} 在飞:${inFlight} (${sec}s)`);
                }
            }

            // ═══ 结果处理 ═══
            if (winnerResult) {
                setState({
                    status: 'success',
                    bizId: winnerResult.bizId,
                    lastSuccess: { text: winnerResult.text, data: winnerResult.data },
                    stats: { ...state.stats, total: totalAttempt, success: state.stats.success + 1 },
                });
                log(`成功! bizId=${winnerResult.bizId} (第${winnerResult.attempt}次, 并发峰值${maxInFlight})`);
                stopCaptchaPreheat();
                recoveryAttempts = 0;
                setTimeout(autoRecover, 500);
                return { ok: true, text: winnerResult.text, data: winnerResult.data, status: winnerResult.status };
            }

            if (!stopRequested) {
                setState({ status: 'failed' });
                log(`达到上限 ${CFG.maxRetry} 次`);
            } else if (lastBatchReasons.some(r => r.includes('会话过期'))) {
                // 已在上面处理
            } else {
                setState({ status: 'idle' });
            }
            return { ok: false };
        })();

        try { return await _retryLock; }
        finally { _retryLock = null; }
    }

    // ═══════════════════════════════════════════
    //  Fetch 拦截
    // ═══════════════════════════════════════════
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input?.url;

        if (url && url.includes(CFG.PREVIEW)) {
            // 捕获请求参数
            const captured = {
                url,
                method: init?.method || 'POST',
                body: init?.body,
                headers: extractHeaders(init?.headers),
            };
            setState({ captured });
            try { sessionStorage.setItem('glm_rush_captured', JSON.stringify(captured)); } catch {}

            // 已经成功过 → 直接返回缓存
            if (state.status === 'success' && state.lastSuccess) {
                log('已抢到, 返回成功响应');
                return new Response(state.lastSuccess.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            // 有缓存 → 返回（来自主动模式成功后的恢复）
            if (state.cache) {
                log('返回缓存响应');
                const c = state.cache;
                setState({ cache: null });
                recoveryAttempts = 0;
                return new Response(c.text, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            // 主动模式/正在抢购 → 进入重试引擎
            if (state.proactive || state.status === 'retrying') {
                log('抢购中, 启动重试...');
                const result = await retry(url, {
                    method: init?.method || 'POST',
                    body: init?.body,
                    headers: extractHeaders(init?.headers),
                });
                if (result.ok) {
                    return new Response(result.text, { status: result.status, headers: { 'Content-Type': 'application/json' } });
                }
                return _fetch.apply(this, [input, init]);
            }

            // 普通捕获 → 清理一次性凭据后记录参数，放行原始请求，自动设定定时
            let cleanBody = init?.body;
            if (cleanBody && typeof cleanBody === 'string') {
                try {
                    const bodyObj = _parse(cleanBody);
                    if (bodyObj.ticket || bodyObj.randstr) {
                        const clean = { ...bodyObj };
                        delete clean.ticket;
                        delete clean.randstr;
                        cleanBody = JSON.stringify(clean);
                    }
                } catch {}
            }
            const capturedClean = {
                url,
                method: init?.method || 'POST',
                body: cleanBody,
                headers: extractHeaders(init?.headers),
            };
            setState({ captured: capturedClean });
            try { sessionStorage.setItem('glm_rush_captured', JSON.stringify(capturedClean)); } catch {}
            log('已捕获请求参数(已清理验证码凭据), 等待抢购时间...');
            autoScheduleIfNeeded();
            return _fetch.apply(this, [input, init]);
        }

        if (url && url.includes(CFG.CHECK) && url.includes('bizId=null')) {
            log('拦截 check(bizId=null)');
            return new Response('{"code":-1,"msg":"等待有效bizId"}', {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }

        return _fetch.apply(this, [input, init]);
    };
    // 伪装
    window.fetch.toString = () => 'function fetch() { [native code] }';

    // ═══════════════════════════════════════════
    //  XHR 拦截
    // ═══════════════════════════════════════════
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;
    const _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        (this._h || (this._h = {}))[k] = v;
        return _xhrSetHeader.call(this, k, v);
    };
    XMLHttpRequest.prototype.open = function (method, url) {
        this._m = method; this._u = url;
        return _xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const url = this._u;

        if (typeof url === 'string' && url.includes(CFG.PREVIEW)) {
            const self = this;
            const captured = { url, method: this._m, body, headers: this._h || {} };
            setState({ captured });
            try { sessionStorage.setItem('glm_rush_captured', JSON.stringify(captured)); } catch {}

            // 已经成功过 → 直接返回缓存
            if (state.status === 'success' && state.lastSuccess) {
                log('已抢到, 返回成功响应 (XHR)');
                fakeXHR(self, state.lastSuccess.text);
                return;
            }

            if (state.cache) {
                log('返回缓存响应 (XHR)');
                const c = state.cache; setState({ cache: null });
                recoveryAttempts = 0;
                fakeXHR(self, c.text);
                return;
            }

            // 主动模式/正在抢购 → 重试
            if (state.proactive || state.status === 'retrying') {
                log('抢购中, 启动重试 (XHR)...');
                retry(url, { method: this._m, body, headers: this._h || {} }).then(result => {
                    fakeXHR(self, result.ok ? result.text : '{"code":-1,"msg":"重试失败"}');
                });
                return;
            }

            // 普通捕获 → 放行原始请求，自动设定定时
            log('已捕获请求参数, 等待抢购时间...');
            autoScheduleIfNeeded();
            return _xhrSend.call(this, body);
        }

        if (typeof url === 'string' && url.includes(CFG.CHECK) && url.includes('bizId=null')) {
            fakeXHR(this, '{"code":-1,"msg":"等待有效bizId"}');
            return;
        }

        return _xhrSend.call(this, body);
    };

    function fakeXHR(xhr, text) {
        setTimeout(() => {
            const dp = (k, v) => Object.defineProperty(xhr, k, { value: v, configurable: true });
            dp('readyState', 4); dp('status', 200); dp('statusText', 'OK');
            dp('responseText', text); dp('response', text);
            const ev = new Event('readystatechange');
            if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange(ev);
            xhr.dispatchEvent(ev);
            const ld = new ProgressEvent('load');
            if (typeof xhr.onload === 'function') xhr.onload(ld);
            xhr.dispatchEvent(ld);
            xhr.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
    }

    // ═══════════════════════════════════════════
    //  弹窗恢复
    // ═══════════════════════════════════════════
    function findErrorDialog() {
        const sels = [
            '.el-dialog', '.el-message-box', '.el-dialog__wrapper',
            '.ant-modal', '.ant-modal-wrap',
            '[class*="modal"]', '[class*="dialog"]', '[class*="popup"]', '[role="dialog"]',
        ];
        for (const sel of sels) {
            for (const el of document.querySelectorAll(sel)) {
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
                if (!el.offsetParent && s.position !== 'fixed') continue;
                if (/购买人数过多|系统繁忙|稍后再试|请重试|繁忙|失败|出错|异常/.test(el.textContent || '')) return el;
            }
        }
        return null;
    }

    function dismissDialog(dialog) {
        // 只在传入的 dialog 内部查找关闭按钮，不 fallback 到 document（避免关掉支付弹窗）
        for (const sel of ['.el-dialog__headerbtn', '.el-message-box__headerbtn', '.ant-modal-close', '[aria-label="Close"]', '[aria-label="close"]']) {
            const btn = dialog.querySelector(sel);
            if (btn && btn.offsetParent !== null) { btn.click(); return true; }
        }
        // 确定/取消按钮（仅 dialog 内部）
        for (const btn of dialog.querySelectorAll('button, [role="button"]')) {
            const t = (btn.textContent || '').trim();
            if (/关闭|确定|取消|知道了|OK|Cancel|Close|确认/.test(t) && t.length < 10) { btn.click(); return true; }
        }
        // 直接隐藏这个 dialog
        dialog.style.display = 'none';
        return true;
    }

    async function autoRecover() {
        if (recovering || recoveryAttempts >= CFG.recoveryMax || !state.lastSuccess) return;

        // 如果页面上有支付相关弹窗，不要干扰
        const payEl = document.querySelector('[class*="pay"], [class*="qrcode"], [class*="wechat"], [class*="alipay"], [class*="cashier"], iframe[src*="pay"]');
        if (payEl && (payEl.offsetParent !== null || window.getComputedStyle(payEl).position === 'fixed')) {
            log('支付弹窗已出现, 跳过恢复');
            return;
        }

        // 只处理明确的错误弹窗，不暴力清理所有弹窗
        const dialog = findErrorDialog();
        if (!dialog) return;

        recovering = true;
        recoveryAttempts++;
        try {
            log('检测到错误弹窗, 清理中...');
            dismissDialog(dialog);
            await sleep(300);

            // 策略2: 缓存响应 + 重新点购买按钮
            setState({ cache: state.lastSuccess });
            const btn = findBuyButton();
            if (btn) {
                btn.click();
                log('已重新点击购买按钮 (策略2)');
                await sleep(2000);
            }

            // 策略3: 检查支付弹窗是否出现, 没有则直接用 bizId 构造支付
            const payDialog = document.querySelector('[class*="pay"], [class*="qrcode"], [class*="wechat"], [class*="alipay"]');
            if (!payDialog || payDialog.offsetParent === null) {
                const bizId = state.bizId;
                if (bizId) {
                    log('支付弹窗未出现, 尝试直接调用 check 页面...');
                    // 尝试直接打开支付 — 有些网站 check 接口会返回支付链接
                    try {
                        const checkUrl = `${location.origin}${CFG.CHECK}?bizId=${encodeURIComponent(bizId)}`;
                        const resp = await _fetch(checkUrl, { credentials: 'include' });
                        const data = await resp.json();
                        log('check响应: ' + JSON.stringify(data).substring(0, 200));

                        // 如果有支付URL, 直接跳转
                        if (data.data && typeof data.data === 'string' && data.data.startsWith('http')) {
                            log('获取到支付链接, 跳转中...');
                            window.open(data.data, '_blank');
                        } else if (data.data && data.data.payUrl) {
                            log('获取到payUrl, 跳转中...');
                            window.open(data.data.payUrl, '_blank');
                        } else if (data.data && data.data.qrCode) {
                            log('获取到二维码数据');
                            showQRCodeFallback(data.data.qrCode, bizId);
                        }
                    } catch (e) {
                        log('check调用失败: ' + e.message);
                    }
                }

                // 策略4: 最终兜底 — 弹窗提醒手动操作
                if (!document.querySelector('[class*="pay"], [class*="qrcode"]')) {
                    log('所有自动恢复策略已尝试, 请手动操作');
                    const bizId = state.bizId;
                    alert(`已抢到 bizId=${bizId}\n\n请尝试:\n1. 刷新页面后立即点击购买\n2. 或手动访问支付页面`);
                }
            } else {
                log('支付弹窗已出现!');
            }
        } finally { recovering = false; }
    }

    /** 兜底: 直接在页面上显示二维码 */
    function showQRCodeFallback(qrData, bizId) {
        const div = document.createElement('div');
        div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;background:#fff;padding:30px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);text-align:center';
        div.innerHTML = `
            <h3 style="margin:0 0 15px;color:#333">扫码支付</h3>
            <img src="${qrData}" style="width:200px;height:200px" onerror="this.parentElement.innerHTML+='<p>二维码加载失败</p>'">
            <p style="margin:15px 0 0;color:#666;font-size:13px">bizId: ${bizId}</p>
            <button onclick="this.parentElement.remove()" style="margin-top:10px;padding:6px 20px;border:1px solid #ddd;border-radius:4px;cursor:pointer">关闭</button>
        `;
        document.body.appendChild(div);
        log('已显示兜底支付二维码');
    }

    // MutationObserver 监控弹窗 (替代 setInterval)
    function setupDialogWatcher() {
        const observer = new MutationObserver(() => {
            if (state.lastSuccess && !recovering && recoveryAttempts < CFG.recoveryMax) {
                const d = findErrorDialog();
                if (d) autoRecover();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ═══════════════════════════════════════════
    //  主动抢购 & 定时
    // ═══════════════════════════════════════════
    function findBuyButton() {
        // 优先找 buy-btn 类的按钮（特惠订阅/订阅升级）
        for (const el of document.querySelectorAll('button.buy-btn')) {
            const t = el.textContent.trim();
            if (el.offsetParent !== null) return el;
        }
        // 降级：通用匹配，排除导航按钮
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            const t = el.textContent.trim();
            if (/购买|抢购|下单|特惠/.test(t) && t.length < 15 && el.offsetParent !== null) return el;
        }
        return null;
    }

    async function startProactive() {
        if (!state.captured) {
            log('请先手动点一次购买按钮');
            alert('请先手动点一次购买/订阅按钮，让脚本捕获请求参数');
            return;
        }
        if (state.status === 'success') {
            log('已经抢到了, 不重复抢购');
            return;
        }
        setState({ proactive: true });
        log(`极速抢购启动! 前${CFG.turboSec}秒${CFG.turboConcurrency}路并发, 之后${CFG.concurrency}路`);

        const { url, method, body, headers } = state.captured;
        const result = await retry(url, { method, body, headers });
        setState({ proactive: false });

        if (result.ok) {
            setState({ cache: { text: result.text, data: result.data } });
            log('抢购成功! 触发支付...');
            // 自动通知
            try { new Notification('GLM 抢购成功!', { body: `bizId=${state.bizId}` }); } catch {}
            const errDlg = findErrorDialog();
            if (errDlg) { dismissDialog(errDlg); await sleep(300); }
            const btn = findBuyButton();
            if (btn) { btn.click(); log('已自动点击购买按钮'); }
            else { alert('已获取到商品! 请立即点击购买按钮!'); }

            // 兜底: 如果 fakeXHR 没能弹出支付窗口, 直接设置 Vue 数据
            await sleep(1500);
            forcePayDialog(result.data);
        }
    }

    function stopAll() {
        stopRequested = true;
        setState({ proactive: false, status: 'idle', count: 0 });
        if (state.timerId) { clearInterval(state.timerId); setState({ timerId: null }); }
        log('已停止');
    }

    // ═══════════════════════════════════════════
    //  北京时间同步 + 自动定时
    // ═══════════════════════════════════════════
    let serverTimeOffset = 0; // 本地时间与服务器时间的差值(ms)

    async function syncServerTime() {
        // 用服务器响应头的 Date 字段同步时间
        try {
            const t0 = Date.now();
            const resp = await _fetch(location.origin + '/api/biz/pay/check?bizId=sync', { credentials: 'include' }).catch(() => null);
            const t1 = Date.now();
            const rtt = t1 - t0;

            if (resp && resp.headers.get('date')) {
                const serverTime = new Date(resp.headers.get('date')).getTime();
                // 服务器时间 ≈ 发送时间 + RTT/2
                serverTimeOffset = serverTime - (t0 + rtt / 2);
                const localNow = new Date(Date.now() + serverTimeOffset);
                log(`时间同步: 服务器偏差 ${serverTimeOffset > 0 ? '+' : ''}${serverTimeOffset}ms (RTT=${rtt}ms)`);
                log(`北京时间: ${localNow.toLocaleTimeString('zh-CN', { hour12: false })}`);
                return;
            }
        } catch {}

        // 备用: 用 worldtimeapi
        try {
            const resp = await fetch('https://worldtimeapi.org/api/timezone/Asia/Shanghai');
            const data = await resp.json();
            const serverTime = new Date(data.datetime).getTime();
            serverTimeOffset = serverTime - Date.now();
            log(`时间同步(备用): 偏差 ${serverTimeOffset > 0 ? '+' : ''}${serverTimeOffset}ms`);
        } catch {
            log('时间同步失败, 使用本地时钟');
            serverTimeOffset = 0;
        }
    }

    function getServerNow() {
        return Date.now() + serverTimeOffset;
    }

    /** 捕获请求后自动设定今天的抢购定时 */
    function autoScheduleIfNeeded() {
        if (state.timerId) return;           // 已经设定了
        if (state.status === 'retrying') return; // 正在抢
        if (state.status === 'success') return;  // 已经抢到了

        const parts = CFG.rushTime.split(':').map(Number);
        const now = new Date(getServerNow());
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts[0], parts[1], parts[2] || 0);

        if (target.getTime() <= getServerNow()) {
            // 已过今天的抢购时间 → 直接开始抢（可能正好在抢购窗口内）
            const passedSec = (getServerNow() - target.getTime()) / 1000;
            if (passedSec < 30) {
                // 过了不到30秒，还在窗口内，直接开抢
                log(`已过${CFG.rushTime} ${passedSec.toFixed(0)}秒, 立即开抢!`);
                startProactive();
            } else {
                log(`今天${CFG.rushTime}已过, 明天自动抢购`);
            }
            return;
        }

        // 未到时间 → 自动设定定时
        scheduleAt(CFG.rushTime);
        log(`已自动设定 ${CFG.rushTime} 抢购`);
    }

    // 定时到指定时间
    function scheduleAt(timeStr) {
        if (state.timerId) { clearInterval(state.timerId); setState({ timerId: null }); }
        const parts = timeStr.split(':').map(Number);
        if (parts.length < 2 || parts[0] > 23 || parts[1] > 59) { log('时间格式错误'); return; }

        const now = new Date(getServerNow());
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts[0], parts[1], parts[2] || 0);
        if (target.getTime() <= getServerNow()) { log('目标时间已过'); return; }

        const ms = target.getTime() - getServerNow();
        log(`定时: ${timeStr} (${Math.ceil(ms / 1000)}秒后, 北京时间)`);

        // 提前3秒自动预热TCP
        if (ms > 4000) {
            setTimeout(() => {
                log('定时前3秒, 自动预热...');
                preheat();
            }, Math.max(0, ms - 3000));
        }

        // 提前5分钟启动验证码预热
        if (ms > 5 * 60 * 1000) {
            setTimeout(() => {
                startCaptchaPreheat();
            }, Math.max(0, ms - 5 * 60 * 1000));
        } else if (ms > 30000) {
            // 不足5分钟但超过30秒，立即启动
            startCaptchaPreheat();
        }

        // 精确等待: 提前 RTT/2 启动，让请求恰好在整点到达服务端
        const rttAdvance = Math.max(Math.round(Math.abs(serverTimeOffset) * 2), 50); // 至少提前 50ms
        const tid = setInterval(() => {
            const remaining = target.getTime() - getServerNow();
            // 更新面板倒计时
            if (remaining > 0 && remaining < 60000) {
                const sec = (remaining / 1000).toFixed(1);
                const timerEl = _shadowRef?.getElementById('timer-info');
                if (timerEl) timerEl.textContent = `-${sec}s`;
            }
            if (remaining <= rttAdvance) {
                clearInterval(tid);
                setState({ timerId: null });
                const timerEl = _shadowRef?.getElementById('timer-info');
                if (timerEl) timerEl.textContent = '';
                log(`时间到! 提前${rttAdvance}ms启动 (补偿网络延迟)`);
                startProactive();
            }
        }, 10);

        setState({ timerId: tid });
    }

    // 预热（增强版：并发建立更多连接）
    async function preheat() {
        try {
            log('TCP预热中...');
            const promises = [];
            for (let i = 0; i < 10; i++) {
                promises.push(
                    _fetch(location.origin + CFG.CHECK + '?bizId=preheat_' + i, { credentials: 'include', priority: 'high' }).catch(() => {})
                );
            }
            for (let i = 0; i < 3; i++) {
                promises.push(
                    _fetch(location.origin + CFG.PREVIEW, { method: 'HEAD', credentials: 'include' }).catch(() => {})
                );
            }
            await Promise.all(promises);
            log('预热完成 (13个连接已建立)');
        } catch { log('预热部分失败，不影响使用'); }
    }

    // ═══════════════════════════════════════════
    //  快捷键
    // ═══════════════════════════════════════════
    document.addEventListener('keydown', e => {
        if (!e.altKey) return;
        if (e.key === 's' || e.key === 'S') { e.preventDefault(); startProactive(); }
        if (e.key === 'x' || e.key === 'X') { e.preventDefault(); stopAll(); }
        if (e.key === 'h' || e.key === 'H') {
            e.preventDefault();
            if (_shadowRef) {
                const bd = _shadowRef.getElementById('bd');
                if (bd) bd.style.display = bd.style.display === 'none' ? '' : 'none';
            }
        }
    });

    // ═══════════════════════════════════════════
    //  Vue isServerBusy 兜底 patch
    // ═══════════════════════════════════════════
    function patchVueServerBusy() {
        let attempts = 0;
        const tid = setInterval(() => {
            attempts++;
            if (attempts > 30) { clearInterval(tid); return; } // 15秒后放弃
            const app = document.querySelector('#app');
            const vue = app && app.__vue__;
            if (!vue) return;
            let patched = 0;
            const walk = (vm, depth) => {
                if (depth > 8) return;
                if (vm.$data && vm.$data.isServerBusy === true) {
                    vm.isServerBusy = false;
                    patched++;
                }
                for (const child of (vm.$children || [])) walk(child, depth + 1);
            };
            walk(vue, 0);
            if (patched > 0) {
                log(`已解除 isServerBusy (${patched}个组件)`);
                clearInterval(tid);
            }
        }, 500);
    }

    /** 兜底: 直接操作 Vue 组件弹出支付窗口 */
    function forcePayDialog(responseData) {
        const app = document.querySelector('#app');
        const vue = app && app.__vue__;
        if (!vue) return;

        let payComp = null;
        const findComp = (vm, depth) => {
            if (depth > 8) return;
            if (vm.$data && 'payDialogVisible' in vm.$data) { payComp = vm; return; }
            for (const child of (vm.$children || [])) { findComp(child, depth + 1); if (payComp) return; }
        };
        findComp(vue, 0);
        if (!payComp) { log('未找到支付组件'); return; }

        // 已经弹出了就不干预
        if (payComp.payDialogVisible) { log('支付弹窗已显示'); return; }

        // 设置 priceData 和 payDialogVisible
        const data = responseData && responseData.data;
        if (data) {
            payComp.priceData = data;
            payComp.payDialogVisible = true;
            log('兜底: 已直接设置 payDialogVisible=true');
        } else {
            log('兜底: 响应数据无 data 字段, 无法设置');
        }
    }

    // ═══════════════════════════════════════════
    //  浮动面板 (Shadow DOM)
    // ═══════════════════════════════════════════
    function createPanel() {
        const host = document.createElement('div');
        host.id = 'glm-rush-host';
        const shadow = host.attachShadow({ mode: 'closed' });

        shadow.innerHTML = `
<style>
:host{all:initial;position:fixed;top:10px;right:10px;z-index:999999;font-family:Consolas,'Courier New',monospace}
*{box-sizing:border-box;margin:0;padding:0}
.panel{width:360px;background:#1a1a2e;color:#e0e0e0;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.6);font-size:13px;line-height:1.5;user-select:none}
.hd{background:linear-gradient(135deg,#0f3460,#16213e);padding:9px 14px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;cursor:move}
.hd b{font-size:14px;letter-spacing:.5px}
.mn{background:none;border:none;color:#aaa;cursor:pointer;font-size:20px;line-height:1;padding:0 4px}
.mn:hover{color:#fff}
.bd{padding:12px 14px 14px}
.st{padding:8px;border-radius:8px;text-align:center;font-weight:700;margin-bottom:10px;transition:background .3s}
.st-idle{background:#2d3436}
.st-retrying{background:#e17055;animation:pulse 1s infinite}
.st-success{background:#00b894}
.st-failed{background:#d63031}
@keyframes pulse{50%{opacity:.7}}
.cap{font-size:11px;padding:5px 8px;background:#2d3436;border-radius:6px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;flex-wrap:wrap}
.row input[type=number],.row input[type=time]{width:60px;padding:4px 6px;border:1px solid #444;border-radius:4px;background:#2d3436;color:#fff;text-align:center;font-size:12px}
.btns{display:flex;gap:8px;margin-bottom:10px}
.btns button{flex:1;padding:8px;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px;color:#fff;transition:opacity .2s}
.btns button:hover{opacity:.85}
.b-go{background:#0984e3}
.b-stop{background:#d63031}
.b-heat{background:#fdcb6e;color:#2d3436}
.b-time{background:#6c5ce7;flex:0 0 auto!important;padding:4px 10px!important}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;font-size:11px;text-align:center}
.stats div{background:#2d3436;border-radius:4px;padding:4px}
.stats .v{font-size:16px;font-weight:700;color:#74b9ff}
.logs{max-height:180px;overflow-y:auto;background:#0d1117;border-radius:6px;padding:6px 8px;font-size:11px;line-height:1.7}
.logs div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.logs .ok{color:#00b894} .logs .warn{color:#fdcb6e} .logs .err{color:#d63031} .logs .info{color:#dfe6e9}
.logs::-webkit-scrollbar{width:4px}
.logs::-webkit-scrollbar-thumb{background:#444;border-radius:2px}
.keys{font-size:10px;color:#636e72;text-align:center;margin-top:6px}
</style>
<div class="panel">
  <div class="hd" id="drag"><b>GLM v4.6</b><button class="mn" id="min">-</button></div>
  <div class="bd" id="bd">
    <div class="st st-idle" id="st">等待中</div>
    <div class="cap" id="cap">${state.captured ? '已恢复上次捕获的请求' : '请先点一次购买按钮'}</div>
    <div class="stats">
      <div><div class="v" id="s-cnt">0</div>重试</div>
      <div><div class="v" id="s-ok">0</div>成功</div>
      <div><div class="v" id="s-err">0</div>错误</div>
    </div>
    <div class="row">
      <span>并发</span><input type="number" id="i-conc" value="${CFG.concurrency}" min="1" max="20" step="1">
      <span>极速</span><input type="number" id="i-turbo" value="${CFG.turboConcurrency}" min="1" max="20" step="1">
      <span>上限</span><input type="number" id="i-max" value="${CFG.maxRetry}" min="10" max="9999" step="50">
    </div>
    <div class="row">
      <span>定时</span><input type="time" id="i-time" step="1">
      <button class="b-time" id="b-time">设定</button>
      <span id="timer-info" style="color:#6c5ce7;font-size:11px"></span>
    </div>
    <div class="btns">
      <button class="b-go" id="b-go">▶ 主动抢购</button>
      <button class="b-stop" id="b-stop" style="display:none">■ 停止</button>
      <button class="b-heat" id="b-heat">预热</button>
    </div>
    <div class="logs" id="logs"></div>
    <div class="keys">Alt+S 抢购 | Alt+X 停止 | Alt+H 隐藏</div>
  </div>
</div>`;

        document.body.appendChild(host);

        const $ = id => shadow.getElementById(id);
        $('b-go').onclick = startProactive;
        $('b-stop').onclick = stopAll;
        $('b-heat').onclick = preheat;
        $('b-time').onclick = () => { const v = $('i-time').value; if (v) scheduleAt(v); };
        $('i-conc').onchange = function() { CFG.concurrency = Math.max(1, +this.value || 5); saveCfg(CFG); };
        $('i-turbo').onchange = function() { CFG.turboConcurrency = Math.max(1, +this.value || 10); saveCfg(CFG); };
        $('i-max').onchange = function() { CFG.maxRetry = Math.max(10, +this.value || 2000); saveCfg(CFG); };
        $('min').onclick = function() {
            const bd = $('bd');
            const hidden = bd.style.display === 'none';
            bd.style.display = hidden ? '' : 'none';
            this.textContent = hidden ? '-' : '+';
        };

        // 拖拽
        let sx, sy, sl, st;
        $('drag').onmousedown = function(e) {
            sx = e.clientX; sy = e.clientY;
            const rect = host.getBoundingClientRect();
            sl = rect.left; st = rect.top;
            const onMove = e => { host.style.left = (sl + e.clientX - sx) + 'px'; host.style.top = (st + e.clientY - sy) + 'px'; host.style.right = 'auto'; host.style.position = 'fixed'; };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };

        // 闭包引用供 refreshUI 使用
        _shadowRef = shadow;

        log('v4.9 已加载 (持续补充+自适应并发+提前量+验证码队列)');
        if (state.captured) log('已恢复上次捕获的请求参数, 可直接设定时间');
        setupDialogWatcher();

        // 兜底: 定时 patch Vue 组件的 isServerBusy (batch-preview 可能在脚本前加载)
        patchVueServerBusy();

        // 自动同步服务器时间
        syncServerTime();

        // 请求通知权限
        if (Notification && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    // ═══════════════════════════════════════════
    //  UI 更新 (rAF 节流)
    // ═══════════════════════════════════════════
    let uiPending = false;

    function refreshUI() {
        if (uiPending) return;
        uiPending = true;
        requestAnimationFrame(() => {
            uiPending = false;
            const shadow = _shadowRef;
            if (!shadow) return;
            const $ = id => shadow.getElementById(id);

            const stEl = $('st');
            if (stEl) {
                stEl.className = 'st st-' + state.status;
                const isTurbo = state.stats.startTime && (performance.now() - state.stats.startTime) < CFG.turboSec * 1000;
                stEl.textContent = state.status === 'idle' ? '等待中'
                    : state.status === 'retrying' ? `${isTurbo ? '⚡极速' : ''}重试中... ${state.count}/${CFG.maxRetry}`
                    : state.status === 'success' ? `成功! bizId=${state.bizId}`
                    : `失败 (${state.count}次)`;
            }

            const capEl = $('cap');
            if (capEl) {
                capEl.textContent = state.captured
                    ? `已捕获: ${state.captured.method} ...${state.captured.url.split('?')[0].slice(-30)}`
                    : '请先点一次购买按钮';
            }

            const cntEl = $('s-cnt'); if (cntEl) cntEl.textContent = state.count;
            const okEl = $('s-ok'); if (okEl) okEl.textContent = state.stats.success;
            const errEl = $('s-err'); if (errEl) errEl.textContent = state.stats.errors;

            const goBtn = $('b-go');
            const stopBtn = $('b-stop');
            if (goBtn && stopBtn) {
                goBtn.style.display = state.status === 'retrying' ? 'none' : '';
                stopBtn.style.display = state.status === 'retrying' ? '' : 'none';
            }
        });
    }

    function appendLogDOM(entry) {
        const shadow = _shadowRef;
        if (!shadow) return;
        const el = shadow.getElementById('logs');
        if (!el) return;
        const div = document.createElement('div');
        div.className = entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : entry.msg.includes('成功') ? 'ok' : 'info';
        div.textContent = `${entry.ts} ${entry.msg}`;
        el.appendChild(div);
        while (el.children.length > CFG.logMax) el.removeChild(el.firstChild);
        el.scrollTop = el.scrollHeight;
    }

    // ═══════════════════════════════════════════
    //  离开保护
    // ═══════════════════════════════════════════
    window.addEventListener('beforeunload', e => {
        if (state.status === 'retrying') {
            e.preventDefault();
            e.returnValue = '抢购正在进行中，确定要离开吗？';
        }
    });

    // ═══════════════════════════════════════════
    //  启动
    // ═══════════════════════════════════════════
    console.log('[GLM] v4.0 已注入');
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createPanel);
    } else {
        createPanel();
    }
})();
