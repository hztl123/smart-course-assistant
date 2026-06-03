// ==UserScript==
// @name         智能刷课助手
// @namespace    smart-course-assistant
// @version      1.0.1
// @description  超星学习通 / U校园 智能刷课刷题助手 | AI搜题 · 倍速播放 · 防卡顿 · 挂时长
// @author       hztl
// @match        *://*.chaoxing.com/*
// @match        *://mooc1-*.edu.cn/*
// @match        *://*.edu.cn/*mooc*
// @match        *://ucontent.unipus.cn/*
// @match        *://ipub.unipus.cn/*
// @match        *://ucloud.unipus.cn/*
// @icon         data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📚</text></svg>
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// @connect      baidu.com
// @connect      www.baidu.com
// @connect      cn.bing.com
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/hztl123/smart-course-assistant
// @supportURL   https://github.com/hztl123/smart-course-assistant/issues
// @updateURL    https://github.com/hztl123/smart-course-assistant/raw/main/smart-course-assistant.user.js
// @downloadURL  https://github.com/hztl123/smart-course-assistant/raw/main/smart-course-assistant.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    //  0. 平台检测 —— 不在目标网站则直接退出
    // ================================================================
    const HOST = location.hostname || '';
    const IS_CHAOXING = /chaoxing\.com|mooc.*\.edu\.cn/.test(HOST);
    const IS_UNIPUS = /unipus\.cn/.test(HOST);
    if (!IS_CHAOXING && !IS_UNIPUS) return;

    // ================================================================
    //  1. 配置 —— 默认值，运行时可被面板修改，刷新后从 GM 存储恢复
    // ================================================================
    const DEFAULTS = {
        // 运行模式: 'video' = 刷课刷题, 'duration' = 挂时长
        mode: 'video',

        // 播放
        playbackRate: 8,
        minSpeed: 1,
        maxSpeed: 16,
        autoMute: true,
        autoStart: false,          // 手动开启

        // 挂时长
        duration: {
            totalMinutes: 60,      // 总挂机时长（分钟）
        },

        // 答题
        autoAnswer: true,
        answerConfidence: 0.7,     // AI 最低置信度

        // 防卡顿 (AntiStall)
        antiStall: {
            enabled: true,
            checkInterval: 2000,
            minBuffer: 3,          // <3s 紧急降速
            lowBuffer: 10,         // <10s 开始降速
            highBuffer: 30,        // >30s 可以提速
            stallThreshold: 3,     // 卡顿超过3秒强制恢复
            speedUpStep: 2,
            speedDownStep: 2,
        },

        // AI
        ai: {
            enabled: true,
            provider: 'deepseek',
            apiKey: '',
            model: 'deepseek-chat',
            baseUrl: 'https://api.deepseek.com/chat/completions',
            timeout: 15000,
        },
    };

    // ================================================================
    //  2. 运行时状态
    // ================================================================
    const STATE = {
        isRunning: false,
        isPaused: false,
        targetSpeed: DEFAULTS.playbackRate,
        currentSpeed: DEFAULTS.playbackRate,

        // 进度统计
        completed: 0,
        total: 0,
        remaining: 0,
        startTime: 0,
        elapsed: 0,
        timerInterval: null,

        // 当前播放
        currentVideo: null,
        currentTitle: '',

        // 答题统计
        answerStats: { ai: 0, web: 0, total: 0 },

        // 防卡顿
        stallTimer: 0,
        lastCurrentTime: 0,
        antiStallInterval: null,

        // 主循环
        mainLoopTimer: null,

        // 当前平台适配器
        adapter: null,
    };

    // ================================================================
    //  3. 持久化配置读写
    // ================================================================
    const Config = {
        _data: { ...DEFAULTS },

        load() {
            try {
                const saved = GM_getValue('sca_config', null);
                if (saved && typeof saved === 'object') {
                    // 深度合并，防止新增字段丢失
                    this._data = deepMerge({ ...DEFAULTS }, saved);
                }
            } catch (e) { /* 使用默认值 */ }
        },

        save() {
            try { GM_setValue('sca_config', this._data); } catch (e) { }
        },

        get(key) {
            const keys = key.split('.');
            let v = this._data;
            for (const k of keys) { if (v == null) return undefined; v = v[k]; }
            return v;
        },

        set(key, value) {
            const keys = key.split('.');
            let obj = this._data;
            for (let i = 0; i < keys.length - 1; i++) {
                if (!(keys[i] in obj)) obj[keys[i]] = {};
                obj = obj[keys[i]];
            }
            obj[keys[keys.length - 1]] = value;
            this.save();
        },
    };

    function deepMerge(base, overlay) {
        const result = { ...base };
        for (const key of Object.keys(overlay)) {
            if (overlay[key] && typeof overlay[key] === 'object' && !Array.isArray(overlay[key])) {
                result[key] = deepMerge(base[key] || {}, overlay[key]);
            } else {
                result[key] = overlay[key];
            }
        }
        return result;
    }

    // ================================================================
    //  4. 日志系统
    // ================================================================
    const LOG_LINES = [];
    const MAX_LOG = 200;

    function addLog(msg, type = 'info') {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const line = { time, msg, type };
        LOG_LINES.push(line);
        if (LOG_LINES.length > MAX_LOG) LOG_LINES.shift();

        // 同时输出到浏览器控制台
        const prefix = type === 'error' ? '❌' : type === 'warn' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
        console.log(`[刷课助手] ${prefix} ${msg}`);

        // 更新面板日志区
        updateLogArea();
    }

    // ================================================================
    //  5. 平台适配器注册表
    //     【扩展点】新增平台只需在此注册一个 Adapter 对象
    // ================================================================
    const PlatformRegistry = {
        adapters: {},
        current: null,

        register(name, adapter) {
            this.adapters[name] = adapter;
        },

        detect() {
            for (const [name, adp] of Object.entries(this.adapters)) {
                if (adp.match()) {
                    this.current = adp;
                    STATE.adapter = adp;
                    addLog(`检测到平台: ${adp.label}`, 'info');
                    return adp;
                }
            }
            return null;
        },
    };

    // ================================================================
    //  5a. 超星学习通 适配器
    // ================================================================
    PlatformRegistry.register('chaoxing', {
        label: '超星学习通',
        name: 'chaoxing',

        match() { return IS_CHAOXING; },

        // ---- 视频检测 ----
        detectVideo() {
            // 策略1: 直接查找 video 元素
            let video = document.querySelector('video');
            if (video && video.duration > 0) return video;

            // 策略2: iframe 内嵌视频（超星常见）
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    if (!doc) continue;
                    const v = doc.querySelector('video');
                    if (v && v.duration > 0) return v;
                } catch (e) { /* 跨域 iframe 无法访问 */ }
            }

            // 策略3: 查找 #video / .ans-cc video 等超星专用容器
            const selectors = ['#video', '.ans-cc video', 'video[id]', '[class*="video"] video'];
            for (const sel of selectors) {
                const v = document.querySelector(sel);
                if (v && v.duration > 0) return v;
            }

            return null;
        },

        // ---- 题目检测 ----
        detectQuestions() {
            const questions = [];

            // 题型1: 单选题 (.el-radio 或 input[type="radio"])
            const singleContainers = document.querySelectorAll('.question-content, .questionBox, .ti-q, [class*="question"]');
            if (singleContainers.length === 0) {
                // 直接找 radio
                const radios = document.querySelectorAll('input[type="radio"]');
                if (radios.length > 0) {
                    const container = radios[0].closest('.question-content, .questionBox, .ti-q') || radios[0].closest('div');
                    const q = this._parseQuestion(container, 'single');
                    if (q) questions.push(q);
                }
            } else {
                singleContainers.forEach(container => {
                    const q = this._parseQuestion(container);
                    if (q) questions.push(q);
                });
            }

            // 题型2: 判断题
            const judgeContainers = document.querySelectorAll('.tf-content, [class*="judge"], [class*="tf"]');
            judgeContainers.forEach(container => {
                if (questions.some(q => q.container === container)) return;
                const q = this._parseQuestion(container, 'judge');
                if (q) questions.push(q);
            });

            // 题型3: 填空题
            const blanks = document.querySelectorAll('.blank-input input, input[type="text"].question-input, textarea[class*="answer"]');
            blanks.forEach(input => {
                const container = input.closest('.question-content, .questionBox, .ti-q') || input.closest('div');
                if (questions.some(q => q.container === container)) return;
                const q = this._parseQuestion(container, 'fill');
                if (q) questions.push(q);
            });

            return questions;
        },

        /** 从题目容器中提取题干和选项 */
        _parseQuestion(container, forceType) {
            if (!container) return null;

            // 提取题干
            let stem = '';
            const stemEl = container.querySelector('.stem, .question-title, .ti-title, h3, h4, .q-title, [class*="stem"], [class*="title"]');
            if (stemEl) {
                stem = (stemEl.textContent || stemEl.innerText || '').replace(/\s+/g, ' ').trim();
            } else {
                // 尝试从整个容器文本中提取
                const fullText = (container.textContent || '').replace(/\s+/g, ' ').trim();
                stem = fullText.substring(0, Math.min(fullText.length, 300));
            }
            if (!stem || stem.length < 3) return null;

            // 提取选项
            const options = [];
            let type = forceType || 'single';

            // 检测 el-radio / el-checkbox
            // 获取所有 radio/checkbox（包括 Element UI 组件）
            const allInputs = container.querySelectorAll('input');
            const radios = [];
            const checks = [];
            allInputs.forEach(inp => {
                if (inp.type === 'radio') radios.push(inp);
                if (inp.type === 'checkbox') checks.push(inp);
            });
            // 也要考虑 .el-radio / .el-checkbox 元素本身
            container.querySelectorAll('.el-radio').forEach(el => { if (!radios.includes(el)) radios.push(el); });
            container.querySelectorAll('.el-checkbox').forEach(el => { if (!checks.includes(el)) checks.push(el); });

            if (checks.length > 0 && radios.length === 0) {
                type = 'multi';
            } else if (radios.length > 0) {
                type = 'single';
            } else if (forceType === 'judge') {
                type = 'judge';
            } else if (forceType === 'fill') {
                type = 'fill';
            }

            if (type === 'single' || type === 'multi') {
                const elements = type === 'multi' ? checks : radios;
                elements.forEach((el, i) => {
                    const label = el.closest('label') || el.parentElement;
                    const text = (label.textContent || label.innerText || el.value || '').replace(/\s+/g, ' ').trim();
                    if (text) {
                        options.push({
                            index: i,
                            letter: String.fromCharCode(65 + i),
                            text: text,
                            element: el,
                        });
                    }
                });
            } else if (type === 'judge') {
                // 判断题选项
                options.push({ index: 0, letter: 'A', text: '正确', element: null });
                options.push({ index: 1, letter: 'B', text: '错误', element: null });
                // 定位实际按钮
                const btns = container.querySelectorAll('button, .el-radio, label, [class*="option"]');
                if (btns.length >= 2) {
                    options[0].element = btns[0];
                    options[1].element = btns[1];
                }
            }

            return {
                type,
                stem,
                options,
                container,
                raw: (container.textContent || '').replace(/\s+/g, ' ').trim(),
            };
        },

        // ---- 答题填入 ----
        fillAnswer(question, answer) {
            if (!answer) return false;
            const ans = String(answer).trim();
            try {
                switch (question.type) {
                    case 'single':
                        return this._fillChoice(question, ans, 'single');
                    case 'multi':
                        return this._fillChoice(question, ans, 'multi');
                    case 'judge':
                        return this._fillJudge(question, ans);
                    case 'fill':
                        return this._fillBlank(question, ans);
                    default:
                        return this._fillChoice(question, ans, 'single') ||
                               this._fillJudge(question, ans) ||
                               this._fillBlank(question, ans);
                }
            } catch (e) {
                addLog(`填入答案失败: ${e.message}`, 'error');
                return false;
            }
        },

        _fillChoice(question, answer, mode) {
            // 解析答案字母
            const letters = answer.match(/[A-Za-z]/g);
            if (!letters) return false;

            const targets = letters.map(l => l.toUpperCase());
            let filled = false;

            question.options.forEach(opt => {
                if (targets.includes(opt.letter)) {
                    const el = opt.element;
                    if (el) {
                        // 尝试多种点击方式
                        this._safeClick(el);
                        // 对于 el-radio/el-checkbox，点击 label 更可靠
                        const label = el.closest('label');
                        if (label && label !== el) this._safeClick(label);
                        filled = true;
                    }
                }
            });

            return filled;
        },

        _fillJudge(question, answer) {
            const isTrue = /正确|对|是|√|true|yes|A|a/.test(answer);
            const target = isTrue ? question.options[0] : question.options[1];
            if (target && target.element) {
                this._safeClick(target.element);
                const label = target.element.closest('label');
                if (label) this._safeClick(label);
                return true;
            }
            return false;
        },

        _fillBlank(question, answer) {
            const inputs = question.container.querySelectorAll('input[type="text"], input:not([type]), textarea');
            if (inputs.length === 0) return false;

            // 支持多空（用分隔符拆分答案）
            const parts = answer.split(/[,;，；\s|]+/).filter(Boolean);
            inputs.forEach((input, i) => {
                if (i < parts.length) {
                    // Vue 兼容写入
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    );
                    if (nativeSetter && nativeSetter.set) {
                        nativeSetter.set.call(input, parts[i]);
                    } else {
                        input.value = parts[i];
                    }
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            return true;
        },

        _safeClick(el) {
            if (!el) return;
            try {
                if (typeof el.click === 'function') el.click();
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            } catch (e) { /* ignore */ }
        },

        // ---- 导航 ----
        getNextButton() {
            // 超星常见的"下一节"按钮选择器
            const selectors = [
                '.next-btn', '.nextBtn', '#nextBtn',
                '.btn_next', '#btnNext',
                'a.next', '.nextChapter',
                '.prev-next .next', '.page-nav .next',
                'button:has(.icon-next)',
                '[title*="下一"]', '[title*="下节"]',
                '.orientationBtn', '.next-button',
                // 泛雅平台
                '.jb_btn_next',
            ];
            for (const sel of selectors) {
                const btn = document.querySelector(sel);
                if (btn && btn.offsetParent !== null) return btn;
            }

            // 文本匹配兜底
            const allBtns = document.querySelectorAll('button, a, .btn, span[role="button"]');
            for (const btn of allBtns) {
                const text = (btn.textContent || btn.innerText || '').trim();
                if (/^下一[章节课]?$|^下一节$|下一章|next/i.test(text) && btn.offsetParent !== null) {
                    return btn;
                }
            }
            return null;
        },

        // ---- 获取当前标题 ----
        getCurrentTitle() {
            const selectors = [
                '.chapter-title', '.course-title', '.video-title',
                '.current-chapter', '.catalog_current',
                'h1', 'h2', '.title',
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) return (el.textContent || el.innerText || '').trim();
            }
            return document.title || '未知';
        },
    });

    // ================================================================
    //  5b. U校园 适配器
    //      参考: github.com/uxudjs/UnipusAIAutoPlayer
    // ================================================================
    PlatformRegistry.register('unipus', {
        label: 'U校园 AI',
        name: 'unipus',

        match() { return IS_UNIPUS; },

        // ---- 视频检测（U校园也有视频播放） ----
        detectVideo() {
            let video = document.querySelector('video');
            if (video && video.duration > 0) return video;

            // U校园的 iframe 嵌套
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    if (!doc) continue;
                    const v = doc.querySelector('video');
                    if (v && v.duration > 0) return v;
                } catch (e) { /* cross-origin */ }
            }
            return null;
        },

        // ---- 题目检测（U校园） ----
        detectQuestions() {
            const questions = [];
            const seen = new Set();
            let debugInfo = [];

            // ── 步骤1: 容器级检测 ──
            const containerSels = [
                '.question-wrapper', '.question-item', '[class*="question"]',
                '.exam-item', '.topic-item', '.test-item',
                '[class*="topic"]', '[class*="exam"]', '.ant-form-item',
                '.single-choose', '.multi-choose', '.judge-item', '.fill-item',
            ];
            const containers = document.querySelectorAll(containerSels.join(','));
            debugInfo.push(`容器检测: ${containers.length} 个候选容器`);

            containers.forEach(container => {
                if (seen.has(container)) return;
                const q = this._parseQuestion(container);
                if (q && q.options.length >= 2) {
                    questions.push(q);
                    seen.add(container);
                }
            });

            // ── 步骤2: 如果容器级没找到，直接在 body 级搜索选项组 ──
            if (questions.length === 0) {
                debugInfo.push('容器级未找到题目，尝试全局搜索...');
                const q = this._parseQuestion(document.body);
                if (q && q.options.length >= 2) {
                    questions.push(q);
                }
            }

            // ── 步骤3: 全局搜索 —— 找页面上所有"看起来像选项组"的元素群 ──
            if (questions.length === 0) {
                debugInfo.push('尝试泛化选项组检测...');
                const groups = this._findAllOptionGroupsOnPage();
                debugInfo.push(`泛化检测找到 ${groups.length} 个选项组`);
                groups.forEach(group => {
                    const q = this._buildQuestionFromGroup(group);
                    if (q && q.options.length >= 2 && !seen.has(q.container)) {
                        questions.push(q);
                        seen.add(q.container);
                    }
                });
            }

            // ── 去重：按题干相似度去重 ──
            const deduped = [];
            const seenStems = new Set();
            const skipped = { part: 0, short: 0, dup: 0, opts: 0 };
            questions.forEach(q => {
                const s = q.stem;
                if (/^Part\s+[IVX]+\b/i.test(s) && q.options.length > 6) { skipped.part++; return; }
                if (/^(Section|Unit|Chapter)\s+\d+/i.test(s)) { skipped.part++; return; }
                if (s.length < 10) { skipped.short++; return; }
                const key = s.substring(0, 40).toLowerCase();
                if (seenStems.has(key)) { skipped.dup++; return; }
                seenStems.add(key);
                if (q.options.length < 2 || q.options.length > 8) { skipped.opts++; return; }
                deduped.push(q);
            });

            // 诊断信息全部输出到面板日志（Tampermonkey 可能拦截 console.log）
            addLog(`U校园检测: 原始${questions.length}题 → 去重${deduped.length}题 (过滤:章节${skipped.part} 太短${skipped.short} 重复${skipped.dup} 选项异常${skipped.opts})`, 'info');

            if (deduped.length > 0) {
                // 输出前3题的详情
                for (let i = 0; i < Math.min(3, deduped.length); i++) {
                    const q = deduped[i];
                    const optInfo = q.options.map(o =>
                        `${o.letter}.(${o.element?.tagName})[${(o.element?.className||'无class').substring(0,25)}]`
                    ).join(' ');
                    addLog(`  Q${i+1}: [${q.type}] ${q.stem.substring(0,50)}... | ${optInfo}`, 'info');
                }
                if (deduped.length > 3) addLog(`  ... 还有 ${deduped.length - 3} 题`, 'info');
            } else {
                addLog(`⚠️ 未找到有效题目！原始${questions.length}题全部被过滤`, 'warn');
                // 降级：放宽过滤条件再试
                if (questions.length > 0) {
                    addLog(`降级模式：放宽条件，输出前5题详情用于调试`, 'warn');
                    for (let i = 0; i < Math.min(5, questions.length); i++) {
                        const q = questions[i];
                        const optInfo = q.options.map(o =>
                            `${o.letter}.(${o.element?.tagName})[${(o.element?.className||'无class').substring(0,25)}]`
                        ).join(' ');
                        addLog(`  Q${i+1}: [${q.type}] n=${q.options.length} stem="${q.stem.substring(0,40)}" | ${optInfo}`, 'warn');
                    }
                }
            }

            return deduped;
        },

        _parseQuestion(container, forceType) {
            if (!container) return null;

            // --- 提取题干 ---
            let stem = '';
            const stemSel = '.question-stem, .stem, .q-title, h3, h4, [class*="stem"], [class*="title"], .topic-title, .question-name, .exam-title';
            const stemEl = container.querySelector(stemSel);
            if (stemEl) {
                stem = (stemEl.textContent || stemEl.innerText || '').replace(/\s+/g, ' ').trim();
            }
            if (!stem || stem.length < 2) {
                const text = (container.textContent || '').replace(/\s+/g, ' ').trim();
                stem = text.substring(0, 300);
            }
            if (!stem || stem.length < 2) return null;

            let type = forceType;
            const options = [];

            // --- 策略A: 所有 input[type=radio/checkbox] ---
            const allInputs = Array.from(container.querySelectorAll('input'));
            const radios = allInputs.filter(inp => inp.type === 'radio' || inp.classList.contains('ant-radio-input'));
            const checks = allInputs.filter(inp => inp.type === 'checkbox' || inp.classList.contains('ant-checkbox-input'));

            const collectOptions = (elements, optType) => {
                elements.forEach((el, i) => {
                    // 爬到包含选项文字的最近父元素
                    let target = el;
                    for (let j = 0; j < 5; j++) {
                        const t = (target.textContent || target.innerText || '').replace(/\s+/g, ' ').trim();
                        if (t.length > el.textContent?.length * 0.7) break;
                        target = target.parentElement;
                        if (!target) { target = el; break; }
                    }
                    const text = (target.textContent || target.innerText || '').replace(/\s+/g, ' ').trim();
                    if (text && text.length > 0) {
                        options.push({ index: i, letter: String.fromCharCode(65 + i), text, element: target });
                    }
                });
            };

            if (radios.length >= 2) { type = type || 'single'; collectOptions(radios); }
            if (checks.length >= 2) { type = type || 'multi'; collectOptions(checks); }
            if (options.length >= 2) {
                addLog(`U校园解析(input): type=${type}, n=${options.length}`, 'info');
                return { type, stem, options, container, raw: stem };
            }

            // --- 策略B: Ant Design 包装器 ---
            const antRadios = Array.from(container.querySelectorAll('.ant-radio-wrapper, .ant-radio'));
            const antChecks = Array.from(container.querySelectorAll('.ant-checkbox-wrapper, .ant-checkbox'));
            options.length = 0;
            if (antRadios.length >= 2) { type = type || 'single'; collectOptions(antRadios); }
            if (antChecks.length >= 2 && options.length === 0) { type = type || 'multi'; collectOptions(antChecks); }
            if (options.length >= 2) {
                addLog(`U校园解析(Ant): type=${type}, n=${options.length}`, 'info');
                return { type, stem, options, container, raw: stem };
            }

            // --- 策略C: U校园专属 —— question-common-abs-choice / option-wrap ---
            options.length = 0;
            const unipusSels = '.question-common-abs-choice, .option-wrap, [class*="common-abs-choice"], [class*="option-wrap"]';
            const unipusOpts = Array.from(container.querySelectorAll(unipusSels));
            if (unipusOpts.length >= 2 && unipusOpts.length <= 8) {
                // 按 class 名分组，只保留最大的组（过滤混入的 review 元素）
                const byClass = {};
                unipusOpts.forEach(el => {
                    const cls = (el.className || '').toString().split(' ').filter(c => c && !/selected|checked|active|hover|focus/i.test(c)).sort().join(' ');
                    if (!byClass[cls]) byClass[cls] = [];
                    byClass[cls].push(el);
                });
                // 取最大组
                const largest = Object.values(byClass).sort((a, b) => b.length - a.length)[0];
                if (largest && largest.length >= 2 && largest.length <= 6) {
                    type = type || 'single';
                    largest.forEach((el, i) => {
                        const text = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
                        if (text && text.length > 0) {
                            options.push({ index: i, letter: String.fromCharCode(65 + i), text, element: el });
                        }
                    });
                }
                if (options.length >= 2) {
                    addLog(`U校园解析(unipus): type=${type}, n=${options.length}`, 'info');
                    return { type, stem, options, container, raw: stem };
                }
            }

            // --- 策略D: 文字模式 —— 找 A. B. C. D. 或 ①②③④ 开头的元素 ---
            options.length = 0;
            const letterPattern = container.querySelectorAll('[class*="option"], [class*="choice"], [class*="answer-"], li, .item, [data-index], [data-option]');
            const letterOptions = [];
            letterPattern.forEach(el => {
                const text = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
                // 检查是否以 A. / B. / 1. / ① 等开头
                if (/^[A-Da-d][.\s、:：)]/.test(text) || /^[1-4][.\s、:：)]/.test(text)) {
                    letterOptions.push({ el, text });
                }
            });
            if (letterOptions.length >= 2 && letterOptions.length <= 10) {
                type = type || 'single';
                letterOptions.forEach((item, i) => {
                    options.push({ index: i, letter: String.fromCharCode(65 + i), text: item.text, element: item.el });
                });
                addLog(`U校园解析(文字模式): type=${type}, n=${options.length}`, 'info');
                return { type, stem, options, container, raw: stem };
            }

            // --- 策略D: 自定义按钮/卡片选项 ---
            options.length = 0;
            const candidateGroups = this._findOptionGroups(container);
            if (candidateGroups.length >= 2) {
                type = type || 'single';
                candidateGroups.forEach((el, i) => {
                    const text = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
                    if (text && text.length > 0) {
                        options.push({ index: i, letter: String.fromCharCode(65 + i), text, element: el });
                    }
                });
                if (options.length >= 2) {
                    addLog(`U校园解析(泛化): type=${type}, n=${options.length}`, 'info');
                    return { type, stem, options, container, raw: stem };
                }
            }

            // --- 策略E: 判断题 ---
            options.length = 0;
            const allBtns = container.querySelectorAll('button, .btn, a, span[role="button"], [class*="true"], [class*="false"]');
            const judgeItems = [];
            allBtns.forEach(btn => {
                const t = (btn.textContent || '').trim();
                if (/^(正确|错误|对|错|是|否|√|×|true|false|yes|no)$/i.test(t)) {
                    judgeItems.push({ element: btn, text: t });
                }
            });
            if (judgeItems.length >= 2) {
                type = 'judge';
                const t = judgeItems.find(j => /正确|对|是|√|true|yes/i.test(j.text));
                const f = judgeItems.find(j => /错误|错|否|×|false|no/i.test(j.text));
                if (t) options.push({ index: 0, letter: 'A', text: '正确', element: t.element });
                if (f) options.push({ index: 1, letter: 'B', text: '错误', element: f.element });
                if (options.length >= 2) {
                    addLog(`U校园解析(判断): n=${options.length}`, 'info');
                    return { type, stem, options, container, raw: stem };
                }
            }

            // --- 策略F: 填空 ---
            const textInputs = container.querySelectorAll('input[type="text"], input:not([type]), textarea, [contenteditable="true"]');
            if (textInputs.length > 0 && !forceType) {
                addLog(`U校园解析(填空): inputs=${textInputs.length}`, 'info');
                return { type: 'fill', stem, options: [], container, raw: stem, inputs: Array.from(textInputs) };
            }

            return null;
        },

        /** 从选项组构建题目对象 */
        _buildQuestionFromGroup(group) {
            if (!group || group.length < 2) return null;
            const container = group[0].closest('div, section, form, body') || document.body;
            const text = (container.textContent || '').replace(/\s+/g, ' ').trim();
            const stem = text.substring(0, 300);
            const options = group.map((el, i) => ({
                index: i,
                letter: String.fromCharCode(65 + i),
                text: (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim(),
                element: el,
            }));
            return { type: 'single', stem, options, container, raw: stem };
        },

        /** 全页面扫描：找所有相似的选项组 */
        _findAllOptionGroupsOnPage() {
            const groups = [];

            // 策略: 找父元素下有≥2个 class 名相同或相似的可点击子元素
            const parents = document.querySelectorAll('div, ul, ol, section, fieldset, form');
            const seenEls = new Set();

            parents.forEach(parent => {
                if (groups.length >= 5) return; // 最多5组

                // 找直接子元素中有 cursor:pointer 且数量 2-8 的
                const children = Array.from(parent.children).filter(child => {
                    if (seenEls.has(child)) return false;
                    try {
                        const style = window.getComputedStyle(child);
                        return style.cursor === 'pointer' && child.offsetParent !== null;
                    } catch (e) { return false; }
                });

                if (children.length >= 2 && children.length <= 8) {
                    // 检查是否包含字母前缀文本（A. B. C. D.）
                    const letterCount = children.filter(c =>
                        /^[A-Da-d][.\s、:：)]/.test((c.textContent || '').trim())
                    ).length;
                    if (letterCount >= 2) {
                        children.forEach(c => seenEls.add(c));
                        groups.push(children);
                    }
                }

                // 也检查通过 class 匹配的子元素
                if (children.length < 2) {
                    const classGroups = {};
                    Array.from(parent.children).forEach(child => {
                        if (seenEls.has(child)) return;
                        const cls = child.className?.toString()?.split(' ').find(c => c.length > 3);
                        if (cls) {
                            if (!classGroups[cls]) classGroups[cls] = [];
                            classGroups[cls].push(child);
                        }
                    });
                    Object.values(classGroups).forEach(g => {
                        if (g.length >= 2 && g.length <= 8 && groups.length < 5) {
                            g.forEach(c => seenEls.add(c));
                            groups.push(g);
                        }
                    });
                }
            });

            return groups;
        },

        /** 寻找容器内相似的可点击子元素组 */
        _findOptionGroups(container) {
            const patterns = ['.option-item', '.choice-item', '.answer-item', '.opt-item',
                '[class*="option"]', '[class*="choice"]', '[class*="answer-item"]', '[class*="select-item"]'];
            for (const pat of patterns) {
                try {
                    const els = container.querySelectorAll(pat);
                    if (els.length >= 2 && els.length <= 10) return Array.from(els);
                } catch (e) { }
            }

            // cursor:pointer 的子元素
            const clickables = [];
            const all = container.querySelectorAll('div, span, li, label, button, a');
            all.forEach(el => {
                if (clickables.length > 10) return;
                try {
                    const style = window.getComputedStyle(el);
                    if (style.cursor === 'pointer' && el.offsetParent !== null) {
                        const text = (el.textContent || '').trim();
                        if (text.length > 1 && text.length < 200) clickables.push(el);
                    }
                } catch (e) { }
            });

            if (clickables.length >= 2 && clickables.length <= 10) return clickables;

            // 找兄弟元素组
            if (clickables.length > 10) {
                const byParent = {};
                clickables.forEach(el => {
                    const p = el.parentElement;
                    if (!p) return;
                    const key = p.tagName + '|' + (p.className?.toString() || '');
                    if (!byParent[key]) byParent[key] = [];
                    if (byParent[key].length < 10) byParent[key].push(el);
                });
                for (const group of Object.values(byParent)) {
                    if (group.length >= 2 && group.length <= 8) return group;
                }
            }

            return [];
        },

        /** U校园答案填入 */
        fillAnswer(question, answer) {
            if (!answer) return false;
            const ans = String(answer).trim();
            addLog(`fillAnswer: type=${question.type}, answer="${ans}", options=${question.options.length}`, 'info');
            try {
                switch (question.type) {
                    case 'single':
                    case 'multi':
                        return this._fillChoiceUnipus(question, ans);
                    case 'judge':
                        return this._fillJudgeUnipus(question, ans);
                    case 'fill':
                        return this._fillBlankUnipus(question, ans);
                    default:
                        return this._fillChoiceUnipus(question, ans);
                }
            } catch (e) {
                addLog(`U校园填入异常: ${e.message}`, 'error');
                return false;
            }
        },

        _fillChoiceUnipus(question, answer) {
            const letters = (answer.match(/[A-Za-z]/g) || []).map(l => l.toUpperCase());
            addLog(`_fillChoiceUnipus: letters=${letters.join(',')}, opts=${question.options.map(o=>o.letter).join(',')}`, 'info');

            if (letters.length === 0) {
                return this._fillByTextMatch(question, answer);
            }

            let filled = false;
            letters.forEach(letter => {
                const opt = question.options.find(o => o.letter === letter);
                if (opt && opt.element) {
                    addLog(`点击选项 ${letter}: <${opt.element.tagName}> class="${opt.element.className?.toString()?.substring(0,30)}"`, 'info');
                    this._clickElement(opt.element);
                    filled = true;
                } else {
                    addLog(`未找到选项 ${letter}`, 'warn');
                }
            });

            // 字母匹配失败时尝试文字匹配
            if (!filled) {
                addLog('字母匹配失败，尝试文字匹配...', 'warn');
                return this._fillByTextMatch(question, answer);
            }
            return filled;
        },

        _fillByTextMatch(question, answer) {
            const cleanAns = answer.replace(/^[A-Za-z][.\s、:：)]*/, '').trim();
            addLog(`文字匹配: 搜索 "${cleanAns.substring(0,40)}"`, 'info');
            for (const opt of question.options) {
                const optText = opt.text.replace(/^[A-Za-z][.\s、:：)]*/, '').trim();
                if (optText.includes(cleanAns) || cleanAns.includes(optText)) {
                    addLog(`文字匹配命中 ${opt.letter}: ${optText.substring(0,30)}`, 'info');
                    if (opt.element) {
                        this._clickElement(opt.element);
                        return true;
                    }
                }
            }
            return false;
        },

        _fillJudgeUnipus(question, answer) {
            const isTrue = /正确|对|是|√|true|yes|A|a/i.test(answer);
            const target = isTrue ? question.options[0] : question.options[1];
            if (target && target.element) {
                this._clickElement(target.element);
                return true;
            }
            return false;
        },

        _fillBlankUnipus(question, answer) {
            const inputs = question.inputs || question.container.querySelectorAll(
                'input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
            );
            if (inputs.length === 0) return false;
            const parts = answer.split(/[,;，；\s|]+/).filter(Boolean);
            inputs.forEach((input, i) => {
                if (i < parts.length) {
                    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                    if (nativeSetter && nativeSetter.set) {
                        nativeSetter.set.call(input, parts[i]);
                    } else {
                        input.value = parts[i];
                    }
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new Event('compositionend', { bubbles: true }));
                }
            });
            return true;
        },

        /** 安全点击 */
        _clickElement(el) {
            if (!el) return;
            try {
                // 确保元素可见可点
                if (typeof el.click === 'function') {
                    el.click();
                    addLog('  → click() 已调用', 'info');
                }
                // 完整鼠标事件链
                ['mousedown', 'mouseup', 'click'].forEach(type => {
                    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                });
                // 点击内部 input/radio
                const inner = el.querySelector('input[type="radio"], input[type="checkbox"]');
                if (inner && inner !== el) {
                    inner.checked = true;
                    inner.dispatchEvent(new Event('change', { bubbles: true }));
                    addLog('  → 内部 input checked', 'info');
                }
                // 还不行的话，尝试点 el 的所有可点父元素
                if (!el.checked && el.tagName !== 'INPUT') {
                    let p = el.parentElement;
                    for (let i = 0; i < 3 && p; i++) {
                        if (typeof p.click === 'function' && p !== el) {
                            p.click();
                            addLog(`  → 父元素 <${p.tagName}> click()`, 'info');
                        }
                        p = p.parentElement;
                    }
                }
            } catch (e) {
                addLog(`点击异常: ${e.message}`, 'warn');
            }
        },

        // ---- U校园特点：目录遍历式“挂时长” ----
        /** 获取右侧目录树的所有叶子节点 */
        getMenuList() {
            const nodes = [];
            const doc = document;

            const containerSelectors = [
                '.pc-slider-menu-container.show .pc-slider-content-menu',
                '.pc-slider-menu-container .pc-slider-content-menu',
                '#part-menu-view .pc-slider-content-menu',
                '#part-menu-view .ant-tree',
                '#part-menu-view',
                '.pc-slider-content-menu',
                '.ant-tree',
                '[role="tree"]',
                '.ant-menu',
            ];

            let menuContainer = null;
            for (const sel of containerSelectors) {
                menuContainer = doc.querySelector(sel);
                if (menuContainer) break;
            }
            if (!menuContainer) return [];

            // 递归收集叶子节点
            const collectLeafs = (el, unitName, sectionName) => {
                const isUnit = el.classList && el.classList.contains('pc-slider-menu-unit');
                const isSection = el.classList && el.classList.contains('pc-slider-menu-section');
                const isMicro = el.classList && el.classList.contains('pc-slider-menu-micro');

                if (isUnit) {
                    const name = this._getNodeName(el);
                    Array.from(el.parentElement ? el.parentElement.children : [])
                        .forEach(c => collectLeafs(c, name, sectionName));
                } else if (isSection) {
                    const name = this._getNodeName(el);
                    Array.from(el.parentElement ? el.parentElement.children : [])
                        .forEach(c => collectLeafs(c, unitName, name));
                } else if (isMicro) {
                    const name = this._getNodeName(el);
                    const clickable = el.querySelector('span') || el;
                    if (name) {
                        nodes.push({ unit: unitName, section: sectionName, micro: name, element: clickable });
                    }
                } else if (el.children && el.children.length > 0) {
                    Array.from(el.children).forEach(c => collectLeafs(c, unitName, sectionName));
                }
            };

            collectLeafs(menuContainer, '', '');
            return nodes;
        },

        _getNodeName(el) {
            const span = el.querySelector('span');
            return (span ? span.textContent : el.textContent || '').replace(/\s+/g, ' ').trim();
        },

        getNextButton() {
            // U校园通常通过点击目录树的下一个节点来"翻页"
            // 没有传统的"下一节"按钮
            return null;
        },

        getCurrentTitle() {
            const menu = this.getMenuList();
            return menu.length > 0 ? `${menu[0].unit} > ${menu[0].section} > ${menu[0].micro}` : 'U校园课程';
        },

        /** 自动关闭 U校园弹窗 */
        handlePopups() {
            const sels = [
                '.know-box .iKnow',
                '.ant-modal-confirm-btns .ant-btn-primary',
                '.ant-modal-confirm-btns .ant-btn.ant-btn-primary',
                '.ipublish-modal-footer-ok',
                'button.ant-btn.ant-btn-default.ipublish-modal-footer-ok',
            ];
            sels.forEach(sel => {
                try {
                    document.querySelectorAll(sel).forEach(btn => {
                        if (btn && btn.offsetParent !== null && typeof btn.click === 'function') {
                            btn.click();
                        }
                    });
                } catch (e) { }
            });
            // 通用文本匹配
            try {
                const allBtns = document.querySelectorAll('button, .btn, a[role="button"]');
                allBtns.forEach(btn => {
                    if (btn.offsetParent === null) return;
                    const text = (btn.textContent || btn.innerText || '').trim();
                    if (/^(我知道了|确认|确定|关闭|知道了|好的|OK)$/i.test(text)) {
                        try { if (typeof btn.click === 'function') btn.click(); } catch (e) { }
                    }
                });
            } catch (e) { }
        },
    });

    // ================================================================
    //  【扩展点】在此注册新平台适配器，如智慧树
    // ================================================================
    // PlatformRegistry.register('zhihuishu', {
    //     label: '智慧树/知到',
    //     name: 'zhihuishu',
    //     match() { return /zhihuishu\.(com|cn)/.test(HOST); },
    //     detectVideo() { /* ... */ },
    //     detectQuestions() { /* ... */ },
    //     fillAnswer(q, a) { /* ... */ },
    //     getNextButton() { /* ... */ },
    //     getCurrentTitle() { /* ... */ },
    // });

    // ================================================================
    //  6. AI 搜题模块
    // ================================================================
    const AIModule = {
        /** DeepSeek API 搜题 */
        async searchViaAI(question) {
            const apiKey = Config.get('ai.apiKey');
            const baseUrl = Config.get('ai.baseUrl');
            const model = Config.get('ai.model');

            if (!apiKey) {
                addLog('AI搜题: 未配置API Key，跳过', 'warn');
                return null;
            }

            const prompt = this._buildPrompt(question);

            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: baseUrl,
                    timeout: Config.get('ai.timeout') || 15000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    data: JSON.stringify({
                        model: model,
                        messages: [
                            { role: 'system', content: '你是一个精准的答题助手。只输出正确答案的字母或文字，不要解释。' },
                            { role: 'user', content: prompt },
                        ],
                        temperature: 0.1,
                        max_tokens: 100,
                    }),
                    onload: function (resp) {
                        try {
                            const res = JSON.parse(resp.responseText);
                            if (res.choices && res.choices[0]) {
                                const answer = (res.choices[0].message.content || '').trim();
                                // 清理常见前缀
                                const clean = answer
                                    .replace(/^(答案[是为：:]?\s*)/i, '')
                                    .replace(/^(正确选项[是为：:]?\s*)/i, '')
                                    .replace(/^(选\s*)/i, '')
                                    .trim();
                                resolve({ answer: clean, confidence: 0.85, source: 'AI' });
                            } else {
                                addLog(`AI返回异常: ${JSON.stringify(res).substring(0, 200)}`, 'warn');
                                resolve(null);
                            }
                        } catch (e) {
                            addLog(`AI响应解析失败: ${e.message}`, 'warn');
                            resolve(null);
                        }
                    },
                    onerror: function () { addLog('AI API 网络请求失败', 'warn'); resolve(null); },
                    ontimeout: function () { addLog('AI API 请求超时', 'warn'); resolve(null); },
                });
            });
        },

        _buildPrompt(question) {
            let prompt = '';
            switch (question.type) {
                case 'single':
                    prompt = `请回答以下单选题，只输出正确答案的字母（如 A）。\n题目：${question.stem}\n`;
                    question.options.forEach(o => { prompt += `${o.letter}. ${o.text}\n`; });
                    break;
                case 'multi':
                    prompt = `请回答以下多选题，只输出所有正确答案的字母（如 ABC）。\n题目：${question.stem}\n`;
                    question.options.forEach(o => { prompt += `${o.letter}. ${o.text}\n`; });
                    break;
                case 'judge':
                    prompt = `请判断以下说法是否正确，只输出"正确"或"错误"。\n${question.stem}`;
                    break;
                case 'fill':
                    prompt = `请回答以下填空题，只输出答案内容，多个空用分号;分隔。\n${question.stem}`;
                    break;
                default:
                    prompt = `请回答以下题目：\n${question.stem}`;
                    if (question.options.length > 0) {
                        question.options.forEach(o => { prompt += `${o.letter}. ${o.text}\n`; });
                    }
            }
            return prompt;
        },

        /** 网页搜索搜题（百度） */
        async searchViaWeb(question, engine = 'baidu') {
            const query = question.stem.substring(0, 100);
            const encoded = encodeURIComponent(query);
            const url = engine === 'bing'
                ? `https://cn.bing.com/search?q=${encoded}`
                : `https://www.baidu.com/s?wd=${encoded}`;

            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: 8000,
                    onload: function (resp) {
                        try {
                            const answer = AIModule._parseSearchResult(resp.responseText, question);
                            if (answer) {
                                resolve({ answer, confidence: 0.5, source: '网页搜索' });
                            } else {
                                resolve(null);
                            }
                        } catch (e) { resolve(null); }
                    },
                    onerror: () => resolve(null),
                    ontimeout: () => resolve(null),
                });
            });
        },

        /** 从百度搜索结果中提取答案 */
        _parseSearchResult(html, question) {
            // 策略：查找搜索结果摘要中是否包含选项文本
            // 从 html 中提取所有可见文本
            const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

            // 如果题目是选择题，统计各选项在搜索结果中的出现频率
            if (question.type === 'single' || question.type === 'multi') {
                const scores = {};
                question.options.forEach(opt => {
                    // 搜索该选项的完整文本或关键词
                    const keywords = opt.text.substring(0, 30);
                    const regex = new RegExp(keywords.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                    const matches = text.match(regex);
                    scores[opt.letter] = matches ? matches.length : 0;
                });

                // 返回出现次数最多的选项
                const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
                if (best && best[1] > 0) {
                    return best[0];
                }
            }

            // 判断题：搜索"正确"或"错误"的出现频率
            if (question.type === 'judge') {
                const trueCount = (text.match(/正确|对|是/g) || []).length;
                const falseCount = (text.match(/错误|错|否/g) || []).length;
                if (trueCount > falseCount * 2) return '正确';
                if (falseCount > trueCount * 2) return '错误';
            }

            return null;
        },

        /** 综合搜题：AI → 网页搜索降级 */
        async search(question) {
            // 第一优先级：AI
            if (Config.get('ai.enabled') && Config.get('ai.apiKey')) {
                const aiResult = await this.searchViaAI(question);
                if (aiResult && aiResult.confidence >= Config.get('answerConfidence')) {
                    STATE.answerStats.ai++;
                    STATE.answerStats.total++;
                    addLog(`AI命中: ${aiResult.answer} (置信度:${(aiResult.confidence * 100).toFixed(0)}%)`, 'success');
                    return aiResult;
                }
                if (aiResult) {
                    addLog(`AI置信度不足(${(aiResult.confidence * 100).toFixed(0)}%)，尝试网页搜索...`, 'warn');
                }
            }

            // 第二优先级：网页搜索
            const webResult = await this.searchViaWeb(question, 'baidu');
            if (webResult) {
                STATE.answerStats.web++;
                STATE.answerStats.total++;
                addLog(`网页搜索命中: ${webResult.answer}`, 'success');
                return webResult;
            }

            addLog('所有搜题渠道均未命中，请手动作答', 'warn');
            return null;
        },
    };

    // ================================================================
    //  7. 智能防卡顿模块 (AntiStall)
    // ================================================================
    const AntiStall = {
        start(video) {
            if (!Config.get('antiStall.enabled')) return;
            this.stop();
            this.video = video;
            STATE.lastCurrentTime = video.currentTime;
            STATE.stallTimer = 0;
            STATE.antiStallInterval = setInterval(() => this.check(video), Config.get('antiStall.checkInterval'));
        },

        stop() {
            if (STATE.antiStallInterval) {
                clearInterval(STATE.antiStallInterval);
                STATE.antiStallInterval = null;
            }
            this.video = null;
        },

        check(video) {
            if (!video || video.paused || video.ended) return;

            const cfg = Config.get('antiStall');
            const buffered = video.buffered;
            let bufferAhead = 0;

            if (buffered.length > 0) {
                for (let i = 0; i < buffered.length; i++) {
                    if (buffered.start(i) <= video.currentTime && buffered.end(i) >= video.currentTime) {
                        bufferAhead = buffered.end(i) - video.currentTime;
                        break;
                    }
                }
            }

            // 检测卡顿
            if (Math.abs(video.currentTime - STATE.lastCurrentTime) < 0.1) {
                STATE.stallTimer += cfg.checkInterval / 1000;
            } else {
                STATE.stallTimer = 0;
            }
            STATE.lastCurrentTime = video.currentTime;

            // 严重卡顿：强制恢复
            if (STATE.stallTimer > cfg.stallThreshold) {
                addLog(`检测到卡顿${STATE.stallTimer.toFixed(1)}秒，强制恢复...`, 'warn');
                video.currentTime += 2; // seek 触发缓冲
                STATE.stallTimer = 0;
                this._adjustSpeed(video, true);
                return;
            }

            // 根据缓冲动态调速
            this._adjustSpeed(video, false, bufferAhead);
        },

        _adjustSpeed(video, isStall, bufferAhead) {
            const cfg = Config.get('antiStall');
            const target = STATE.targetSpeed;

            if (isStall) {
                // 卡顿时大幅降速
                STATE.currentSpeed = Math.max(cfg.minSpeed, video.playbackRate / 4);
            } else if (bufferAhead < cfg.minBuffer) {
                // 缓冲严重不足
                STATE.currentSpeed = Math.max(cfg.minSpeed, video.playbackRate - cfg.speedDownStep * 2);
            } else if (bufferAhead < cfg.lowBuffer) {
                // 缓冲偏低
                STATE.currentSpeed = Math.max(cfg.minSpeed, video.playbackRate - cfg.speedDownStep);
            } else if (bufferAhead > cfg.highBuffer) {
                // 缓冲充足，逐步回升到目标倍速
                STATE.currentSpeed = Math.min(target, video.playbackRate + cfg.speedUpStep);
            } else {
                // 适中：保持当前
                STATE.currentSpeed = video.playbackRate;
            }

            STATE.currentSpeed = Math.round(STATE.currentSpeed * 10) / 10;
            video.playbackRate = STATE.currentSpeed;
        },
    };

    // ================================================================
    //  7b. 挂时长引擎 (用于 U校园等平台的目录遍历式挂机)
    //      参考: github.com/uxudjs/UnipusAIAutoPlayer
    // ================================================================
    const DurationEngine = {
        menuNodes: [],           // 所有叶子节点
        currentNodeIdx: 0,       // 当前节点索引
        currentStepStart: 0,     // 当前步骤开始时间
        currentStepDuration: 0,  // 当前步骤需等待的秒数
        countdownInterval: null, // 倒计时刷新
        isRunning: false,
        isPaused: false,

        /** 初始化：从适配器获取目录树并分配时间 */
        init(adapter, totalMinutes) {
            this.adapter = adapter;
            this.totalMinutes = totalMinutes;
            this.menuNodes = [];

            if (adapter.getMenuList) {
                this.menuNodes = adapter.getMenuList();
            }

            if (this.menuNodes.length === 0) {
                addLog('未找到课程目录节点，无法挂时长', 'error');
                return false;
            }

            // 均分时间（秒）
            const totalSeconds = totalMinutes * 60;
            const perNode = Math.floor(totalSeconds / this.menuNodes.length);

            this.menuNodes = this.menuNodes.map((node, i) => ({
                ...node,
                allocated: perNode,
                completed: false,
            }));

            // 把除不尽的时间加到最后一个节点
            const remainder = totalSeconds - perNode * this.menuNodes.length;
            if (remainder > 0 && this.menuNodes.length > 0) {
                this.menuNodes[this.menuNodes.length - 1].allocated += remainder;
            }

            addLog(`挂时长初始化: ${this.menuNodes.length} 个节点, 每节点 ${Math.floor(perNode / 60)}分${perNode % 60}秒`, 'info');
            return true;
        },

        start() {
            if (this.menuNodes.length === 0) return false;
            this.isRunning = true;
            this.isPaused = false;
            this.currentNodeIdx = this.menuNodes.findIndex(n => !n.completed);
            if (this.currentNodeIdx < 0) this.currentNodeIdx = 0;

            // 点击第一个节点
            this._clickCurrentNode();
            this._startCountdown();
            addLog('🚀 开始挂时长', 'info');
            return true;
        },

        pause() {
            this.isPaused = true;
            if (this.countdownInterval) { clearInterval(this.countdownInterval); this.countdownInterval = null; }
            addLog('⏸ 挂时长已暂停', 'info');
        },

        resume() {
            this.isPaused = false;
            this.currentStepStart = Date.now();
            this._startCountdown();
            addLog('▶ 挂时长已恢复', 'info');
        },

        stop() {
            this.isRunning = false;
            this.isPaused = false;
            if (this.countdownInterval) { clearInterval(this.countdownInterval); this.countdownInterval = null; }
            addLog('⏹ 挂时长已停止', 'info');
        },

        reset() {
            this.stop();
            this.menuNodes = [];
            this.currentNodeIdx = 0;
            this.currentStepStart = 0;
            this.currentStepDuration = 0;
        },

        /** 点击当前节点 */
        _clickCurrentNode() {
            const node = this.menuNodes[this.currentNodeIdx];
            if (!node) return;

            addLog(`切换到: ${node.unit || ''} > ${node.section || ''} > ${node.micro || ''}`, 'info');
            STATE.currentTitle = `${node.micro} (${node.unit})`;

            // 点击节点元素
            if (node.element && typeof node.element.click === 'function') {
                try {
                    node.element.click();
                } catch (e) {
                    addLog(`点击节点失败: ${e.message}`, 'error');
                }
            }

            this.currentStepStart = Date.now();
            this.currentStepDuration = node.allocated;
        },

        /** 启动倒计时刷新 */
        _startCountdown() {
            if (this.countdownInterval) clearInterval(this.countdownInterval);
            this.countdownInterval = setInterval(() => {
                if (!this.isRunning || this.isPaused) return;

                const elapsed = Math.floor((Date.now() - this.currentStepStart) / 1000);
                const remaining = Math.max(0, this.currentStepDuration - elapsed);

                // 更新面板倒计时
                const cdEl = document.getElementById('sca-countdown');
                if (cdEl) {
                    cdEl.textContent = `倒计时: ${formatTime(remaining)}`;
                }

                // 更新进度
                STATE.elapsed = Math.floor((Date.now() - STATE.startTime) / 1000);
                STATE.completed = this.currentNodeIdx;
                STATE.remaining = this.menuNodes.length - this.currentNodeIdx;

                // 处理弹窗
                if (this.adapter.handlePopups) {
                    this.adapter.handlePopups();
                }

                // 检测题目
                const questions = this.adapter.detectQuestions();
                if (questions.length > 0 && Config.get('autoAnswer')) {
                    handleQuestions(questions);
                }

                // 时间到了：切换到下一个节点
                if (remaining <= 0) {
                    this.menuNodes[this.currentNodeIdx].completed = true;
                    this.currentNodeIdx++;

                    if (this.currentNodeIdx >= this.menuNodes.length) {
                        // 全部完成
                        this.stop();
                        addLog('✅ 挂时长全部完成！', 'success');
                        STATE.completed = this.menuNodes.length;
                        STATE.remaining = 0;
                        updatePanel();
                        return;
                    }

                    this._clickCurrentNode();
                }

                updatePanel();
            }, 1000);
        },

        /** 获取当前步骤剩余秒数 */
        getRemaining() {
            if (!this.isRunning) return 0;
            const elapsed = Math.floor((Date.now() - this.currentStepStart) / 1000);
            return Math.max(0, this.currentStepDuration - elapsed);
        },
    };

    // ================================================================
    //  8. UI 面板
    // ================================================================
    const PANEL_ID = 'sca-panel';
    let panelEl = null;

    // CSS 样式注入
    GM_addStyle(`
        #${PANEL_ID} {
            position: fixed; top: 80px; right: 16px; z-index: 99999;
            width: 320px; max-height: 80vh;
            background: #fff; border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.1);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px; color: #333;
            overflow: hidden; user-select: none;
            transition: opacity 0.2s, transform 0.2s;
        }
        #${PANEL_ID}.minimized {
            width: 48px; height: 48px; border-radius: 50%;
            overflow: hidden; cursor: pointer;
        }
        #sca-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 10px 14px; background: #f8f9fa; border-bottom: 1px solid #eee;
            cursor: move; font-weight: 600; font-size: 14px;
        }
        #sca-header .sca-btns { display: flex; gap: 6px; }
        #sca-header .sca-btns button {
            width: 24px; height: 24px; border: none; border-radius: 4px;
            background: transparent; cursor: pointer; font-size: 14px; line-height: 1;
            color: #666; transition: background 0.15s;
        }
        #sca-header .sca-btns button:hover { background: #e0e0e0; }
        #sca-body { padding: 14px; max-height: calc(80vh - 48px); overflow-y: auto; }
        #sca-body.minimized { display: none; }

        .sca-status { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .sca-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
        .sca-dot.running { background: #4caf50; animation: sca-pulse 1.5s ease-in-out infinite; }
        .sca-dot.paused { background: #ff9800; }
        .sca-dot.done { background: #2196f3; }
        .sca-dot.idle { background: #bbb; }
        @keyframes sca-pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

        .sca-progress { height: 6px; background: #eee; border-radius: 3px; margin-bottom: 12px; overflow: hidden; }
        .sca-progress-bar { height: 100%; background: linear-gradient(90deg, #4caf50, #8bc34a); border-radius: 3px; transition: width 0.5s; }

        .sca-stats { display: flex; gap: 8px; margin-bottom: 12px; }
        .sca-stat { flex:1; text-align: center; background: #f5f5f5; border-radius: 8px; padding: 8px 4px; }
        .sca-stat-val { font-size: 18px; font-weight: 700; color: #333; }
        .sca-stat-label { font-size: 10px; color: #999; margin-top: 2px; }

        .sca-current { margin-bottom: 10px; padding: 8px 10px; background: #fff9e6; border-radius: 6px; font-size: 12px; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        .sca-btns-row { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
        .sca-btn {
            flex: 1; min-width: 60px; padding: 7px 0; border: none; border-radius: 6px;
            cursor: pointer; font-size: 12px; font-weight: 500; transition: all 0.15s;
        }
        .sca-btn.primary { background: #4caf50; color: #fff; }
        .sca-btn.primary:hover { background: #43a047; }
        .sca-btn.primary.running { background: #ff9800; }
        .sca-btn.default { background: #f0f0f0; color: #333; }
        .sca-btn.default:hover { background: #e0e0e0; }
        .sca-btn.small { flex: 0; min-width: auto; padding: 7px 10px; }

        .sca-speed-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        .sca-speed-row input[type=range] { flex: 1; accent-color: #4caf50; }
        .sca-speed-val { font-weight: 700; min-width: 32px; text-align: center; font-size: 14px; }

        .sca-log { margin-top: 8px; }
        .sca-log-toggle { font-size: 12px; color: #999; cursor: pointer; margin-bottom: 4px; }
        .sca-log-area { max-height: 150px; overflow-y: auto; font-size: 11px; background: #fafafa; border-radius: 6px; padding: 6px 8px; display: none; }
        .sca-log-area.show { display: block; }
        .sca-log-line { padding: 2px 0; border-bottom: 1px solid #f0f0f0; display: flex; gap: 6px; }
        .sca-log-time { color: #bbb; flex-shrink: 0; }
        .sca-log-msg.info { color: #666; }
        .sca-log-msg.success { color: #4caf50; }
        .sca-log-msg.warn { color: #ff9800; }
        .sca-log-msg.error { color: #f44336; }

        .sca-settings { margin-top: 8px; }
        .sca-settings-toggle { font-size: 12px; color: #999; cursor: pointer; }
        .sca-settings-body { display: none; margin-top: 6px; }
        .sca-settings-body.show { display: block; }
        .sca-setting-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 12px; }
        .sca-setting-row input[type=text], .sca-setting-row select {
            width: 140px; padding: 4px 6px; border: 1px solid #ddd; border-radius: 4px; font-size: 11px;
        }
        .sca-setting-row input[type=checkbox] { margin: 0; }
    `);

    function createPanel() {
        // 避免重复创建
        if (document.getElementById(PANEL_ID)) return;
        panelEl = document.getElementById(PANEL_ID);
        if (panelEl) return;

        panelEl = document.createElement('div');
        panelEl.id = PANEL_ID;
        const isDuration = Config.get('mode') === 'duration';
        panelEl.innerHTML = `
            <div id="sca-header">
                <span>📚 智能刷课助手</span>
                <div class="sca-btns">
                    <button id="sca-btn-min" title="最小化">−</button>
                    <button id="sca-btn-close" title="关闭">×</button>
                </div>
            </div>
            <div id="sca-body">
                <!-- 模式切换 -->
                <div class="sca-mode-tabs" style="display:flex;margin-bottom:10px;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;">
                    <button id="sca-mode-video" class="sca-mode-tab" style="flex:1;padding:6px 0;border:none;cursor:pointer;font-size:12px;font-weight:500;background:${isDuration ? '#f5f5f5' : '#4caf50'};color:${isDuration ? '#666' : '#fff'};transition:all 0.15s;">🎬 刷课</button>
                    <button id="sca-mode-duration" class="sca-mode-tab" style="flex:1;padding:6px 0;border:none;cursor:pointer;font-size:12px;font-weight:500;background:${isDuration ? '#4caf50' : '#f5f5f5'};color:${isDuration ? '#fff' : '#666'};transition:all 0.15s;">⏱ 挂时长</button>
                </div>
                <!-- 状态行 -->
                <div class="sca-status">
                    <span class="sca-dot idle" id="sca-dot"></span>
                    <span id="sca-status-text" style="font-size:13px">待命中</span>
                    <span style="flex:1;text-align:right;font-size:12px;color:#999" id="sca-platform"></span>
                </div>
                <!-- 进度条 -->
                <div class="sca-progress"><div class="sca-progress-bar" id="sca-bar" style="width:0%"></div></div>
                <!-- 统计卡片 -->
                <div class="sca-stats">
                    <div class="sca-stat"><div class="sca-stat-val" id="sca-done">0</div><div class="sca-stat-label">已完成</div></div>
                    <div class="sca-stat"><div class="sca-stat-val" id="sca-left">--</div><div class="sca-stat-label">剩余</div></div>
                    <div class="sca-stat"><div class="sca-stat-val" id="sca-time">00:00</div><div class="sca-stat-label">用时</div></div>
                </div>
                <!-- 当前播放 / 倒计时 -->
                <div class="sca-current" id="sca-title">等待开始...</div>
                <!-- 挂时长专属：倒计时 + 时长设置 -->
                <div id="sca-duration-controls" style="display:${isDuration ? 'block' : 'none'};margin-bottom:10px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                        <span style="font-size:11px;color:#999;">总时长(分钟)</span>
                        <input type="number" id="sca-duration-minutes" min="1" max="600" value="${Config.get('duration.totalMinutes')}"
                            style="width:70px;padding:4px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                        <span id="sca-countdown" style="font-size:12px;font-weight:700;color:#4caf50;margin-left:auto;">倒计时: --:--</span>
                    </div>
                </div>
                <!-- 视频专属：倍速滑块 -->
                <div id="sca-speed-controls" style="display:${isDuration ? 'none' : 'flex'};" class="sca-speed-row">
                    <span style="font-size:11px;color:#999">倍速</span>
                    <input type="range" id="sca-speed" min="1" max="16" step="0.5" value="${Config.get('playbackRate')}">
                    <span class="sca-speed-val" id="sca-speed-label">${Config.get('playbackRate')}x</span>
                </div>
                <!-- 按钮区 -->
                <div class="sca-btns-row">
                    <button class="sca-btn primary" id="sca-btn-start">▶ 开始${isDuration ? '挂时长' : '刷课'}</button>
                    <button class="sca-btn default small" id="sca-btn-mute" style="display:${isDuration ? 'none' : 'inline'}">🔇</button>
                    <button class="sca-btn default small" id="sca-btn-reset">↻</button>
                </div>
                <!-- 日志 -->
                <div class="sca-log">
                    <div class="sca-log-toggle" id="sca-log-toggle">📋 日志 ▸</div>
                    <div class="sca-log-area" id="sca-log-area"></div>
                </div>
                <!-- 设置 -->
                <div class="sca-settings">
                    <div class="sca-settings-toggle" id="sca-settings-toggle">⚙ 设置 ▸</div>
                    <div class="sca-settings-body" id="sca-settings-body">
                        <div class="sca-setting-row">
                            <span>AI 搜题</span>
                            <input type="checkbox" id="sca-cfg-ai-enabled" ${Config.get('ai.enabled') ? 'checked' : ''}>
                        </div>
                        <div class="sca-setting-row">
                            <span>API Key</span>
                            <input type="text" id="sca-cfg-ai-key" value="${escapeHtml(Config.get('ai.apiKey') || '')}" placeholder="sk-xxx">
                        </div>
                        <div class="sca-setting-row">
                            <span>AI 模型</span>
                            <input type="text" id="sca-cfg-ai-model" value="${escapeHtml(Config.get('ai.model') || '')}" placeholder="deepseek-chat">
                        </div>
                        <div class="sca-setting-row">
                            <span>自动答题</span>
                            <input type="checkbox" id="sca-cfg-auto-answer" ${Config.get('autoAnswer') ? 'checked' : ''}>
                        </div>
                        <div class="sca-setting-row">
                            <span>自动静音</span>
                            <input type="checkbox" id="sca-cfg-auto-mute" ${Config.get('autoMute') ? 'checked' : ''}>
                        </div>
                        <div class="sca-setting-row">
                            <span>智能防卡顿</span>
                            <input type="checkbox" id="sca-cfg-anti-stall" ${Config.get('antiStall.enabled') ? 'checked' : ''}>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panelEl);

        // ---- 事件绑定 ----
        bindPanelEvents();
    }

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function bindPanelEvents() {
        // 拖拽
        initDrag();

        // 模式切换 — 刷课
        document.getElementById('sca-mode-video').addEventListener('click', () => {
            if (STATE.isRunning) { addLog('请先停止当前任务再切换模式', 'warn'); return; }
            Config.set('mode', 'video');
            refreshPanelMode();
        });

        // 模式切换 — 挂时长
        document.getElementById('sca-mode-duration').addEventListener('click', () => {
            if (STATE.isRunning) { addLog('请先停止当前任务再切换模式', 'warn'); return; }
            Config.set('mode', 'duration');
            refreshPanelMode();
        });

        // 最小化
        document.getElementById('sca-btn-min').addEventListener('click', () => {
            panelEl.classList.toggle('minimized');
            document.getElementById('sca-body').classList.toggle('minimized');
            const btn = document.getElementById('sca-btn-min');
            btn.textContent = panelEl.classList.contains('minimized') ? '+' : '−';
        });

        // 关闭
        document.getElementById('sca-btn-close').addEventListener('click', () => {
            stopAll();
            panelEl.style.display = 'none';
        });

        // 开始/暂停（支持两种模式）
        document.getElementById('sca-btn-start').addEventListener('click', () => {
            const mode = Config.get('mode');
            if (mode === 'duration') {
                if (DurationEngine.isRunning && !DurationEngine.isPaused) {
                    DurationEngine.pause();
                    STATE.isRunning = false;
                    STATE.isPaused = true;
                    updatePanel();
                } else if (DurationEngine.isPaused) {
                    DurationEngine.resume();
                    STATE.isRunning = true;
                    STATE.isPaused = false;
                    updatePanel();
                } else {
                    startDurationRun();
                }
            } else {
                if (STATE.isRunning && !STATE.isPaused) {
                    pauseRun();
                } else if (STATE.isPaused) {
                    resumeRun();
                } else {
                    startRun();
                }
            }
        });

        // 静音
        document.getElementById('sca-btn-mute').addEventListener('click', toggleMute);

        // 重置
        document.getElementById('sca-btn-reset').addEventListener('click', resetAll);

        // 倍速滑块
        document.getElementById('sca-speed').addEventListener('input', function () {
            const val = parseFloat(this.value);
            STATE.targetSpeed = val;
            STATE.currentSpeed = val;
            Config.set('playbackRate', val);
            document.getElementById('sca-speed-label').textContent = val + 'x';
            if (STATE.currentVideo) {
                STATE.currentVideo.playbackRate = val;
            }
        });

        // 日志折叠
        document.getElementById('sca-log-toggle').addEventListener('click', function () {
            const area = document.getElementById('sca-log-area');
            area.classList.toggle('show');
            this.textContent = area.classList.contains('show') ? '📋 日志 ▾' : '📋 日志 ▸';
        });

        // 设置折叠
        document.getElementById('sca-settings-toggle').addEventListener('click', function () {
            const body = document.getElementById('sca-settings-body');
            body.classList.toggle('show');
            this.textContent = body.classList.contains('show') ? '⚙ 设置 ▾' : '⚙ 设置 ▸';
        });

        // 设置项变更
        document.getElementById('sca-cfg-ai-enabled').addEventListener('change', function () {
            Config.set('ai.enabled', this.checked);
        });
        document.getElementById('sca-cfg-ai-key').addEventListener('change', function () {
            Config.set('ai.apiKey', this.value.trim());
            addLog('AI Key 已保存', 'info');
        });
        document.getElementById('sca-cfg-ai-model').addEventListener('change', function () {
            Config.set('ai.model', this.value.trim());
        });
        document.getElementById('sca-cfg-auto-answer').addEventListener('change', function () {
            Config.set('autoAnswer', this.checked);
        });
        document.getElementById('sca-cfg-auto-mute').addEventListener('change', function () {
            Config.set('autoMute', this.checked);
        });
        document.getElementById('sca-cfg-anti-stall').addEventListener('change', function () {
            Config.set('antiStall.enabled', this.checked);
        });

        // 挂时长分钟数
        const durInput = document.getElementById('sca-duration-minutes');
        if (durInput) {
            durInput.addEventListener('change', function () {
                const v = parseInt(this.value);
                if (v >= 1) Config.set('duration.totalMinutes', v);
            });
        }
    }

    /** 面板拖拽 */
    function initDrag() {
        const header = document.getElementById('sca-header');
        let isDragging = false, startX, startY, startLeft, startTop;

        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panelEl.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            panelEl.style.transition = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panelEl.style.right = 'auto';
            panelEl.style.left = Math.min(Math.max(startLeft + dx, 0), window.innerWidth - panelEl.offsetWidth) + 'px';
            panelEl.style.top = Math.min(Math.max(startTop + dy, 0), window.innerHeight - 48) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                panelEl.style.transition = '';
            }
        });
    }

    /** 更新日志区域 */
    function updateLogArea() {
        const area = document.getElementById('sca-log-area');
        if (!area) return;
        const recent = LOG_LINES.slice(-30);
        area.innerHTML = recent.map(l =>
            `<div class="sca-log-line"><span class="sca-log-time">${l.time}</span><span class="sca-log-msg ${l.type}">${escapeHtml(l.msg)}</span></div>`
        ).join('');
        area.scrollTop = area.scrollHeight;
    }

    /** 更新面板状态 */
    function updatePanel() {
        const isDuration = Config.get('mode') === 'duration';
        const dot = document.getElementById('sca-dot');
        const statusText = document.getElementById('sca-status-text');
        const btnStart = document.getElementById('sca-btn-start');
        const platform = document.getElementById('sca-platform');

        if (platform && STATE.adapter) {
            platform.textContent = STATE.adapter.label;
        }

        dot.className = 'sca-dot';
        if (STATE.isRunning && !STATE.isPaused) {
            dot.classList.add('running');
            statusText.textContent = isDuration ? '挂机中' : '运行中';
            btnStart.textContent = '⏸ 暂停';
            btnStart.classList.add('running');
        } else if (STATE.isPaused) {
            dot.classList.add('paused');
            statusText.textContent = '已暂停';
            btnStart.textContent = '▶ 继续';
            btnStart.classList.add('running');
        } else if (STATE.completed > 0 && STATE.remaining === 0) {
            dot.classList.add('done');
            statusText.textContent = '全部完成';
            btnStart.textContent = isDuration ? '▶ 开始挂时长' : '▶ 开始刷课';
            btnStart.classList.remove('running');
        } else {
            dot.classList.add('idle');
            statusText.textContent = '待命中';
            btnStart.textContent = isDuration ? '▶ 开始挂时长' : '▶ 开始刷课';
            btnStart.classList.remove('running');
        }

        document.getElementById('sca-done').textContent = STATE.completed;
        document.getElementById('sca-left').textContent = STATE.remaining > 0 ? STATE.remaining : '--';
        document.getElementById('sca-time').textContent = formatTime(STATE.elapsed);
        document.getElementById('sca-title').textContent = STATE.currentTitle || '等待开始...';

        // 进度条
        const bar = document.getElementById('sca-bar');
        if (isDuration && DurationEngine.menuNodes.length > 0) {
            const total = DurationEngine.menuNodes.length;
            const done = DurationEngine.menuNodes.filter(n => n.completed).length;
            bar.style.width = Math.round((done / total) * 100) + '%';
        } else if (STATE.remaining > 0 || STATE.completed > 0) {
            const total = STATE.completed + STATE.remaining;
            bar.style.width = total > 0 ? Math.round((STATE.completed / total) * 100) + '%' : '0%';
        } else {
            bar.style.width = '0%';
        }

        // 倍速滑块
        const speedSlider = document.getElementById('sca-speed');
        const speedLabel = document.getElementById('sca-speed-label');
        if (speedSlider) speedSlider.value = STATE.targetSpeed;
        if (speedLabel) speedLabel.textContent = STATE.targetSpeed + 'x';
    }

    function formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    /** 刷新面板模式 UI（刷课/挂时长切换时调用） */
    function refreshPanelMode() {
        const isDuration = Config.get('mode') === 'duration';
        // 更新模式标签样式
        const btnV = document.getElementById('sca-mode-video');
        const btnD = document.getElementById('sca-mode-duration');
        if (btnV && btnD) {
            btnV.style.background = isDuration ? '#f5f5f5' : '#4caf50';
            btnV.style.color = isDuration ? '#666' : '#fff';
            btnD.style.background = isDuration ? '#4caf50' : '#f5f5f5';
            btnD.style.color = isDuration ? '#fff' : '#666';
        }
        // 显示/隐藏对应控件
        const durControls = document.getElementById('sca-duration-controls');
        const spdControls = document.getElementById('sca-speed-controls');
        const muteBtn = document.getElementById('sca-btn-mute');
        const startBtn = document.getElementById('sca-btn-start');
        if (durControls) durControls.style.display = isDuration ? 'block' : 'none';
        if (spdControls) spdControls.style.display = isDuration ? 'none' : 'flex';
        if (muteBtn) muteBtn.style.display = isDuration ? 'none' : 'inline';
        if (startBtn) startBtn.textContent = isDuration ? '▶ 开始挂时长' : '▶ 开始刷课';
        // 同步时长设置
        const minInput = document.getElementById('sca-duration-minutes');
        if (minInput) minInput.value = Config.get('duration.totalMinutes');
        updatePanel();
    }

    // ================================================================
    //  9. 核心引擎
    // ================================================================

    /** 开始刷课 */
    function startRun() {
        if (!STATE.adapter) {
            addLog('未检测到支持的平台', 'error');
            return;
        }
        STATE.isRunning = true;
        STATE.isPaused = false;
        STATE.startTime = Date.now();
        STATE.elapsed = 0;
        STATE.completed = 0;
        STATE.remaining = 0;
        STATE.currentSpeed = STATE.targetSpeed;

        // 计时器
        STATE.timerInterval = setInterval(() => {
            STATE.elapsed = Math.floor((Date.now() - STATE.startTime) / 1000);
            updatePanel();
        }, 1000);

        // 初始化倍速
        const video = STATE.adapter.detectVideo();
        if (video) {
            STATE.currentVideo = video;
            video.playbackRate = STATE.targetSpeed;
            if (Config.get('autoMute')) video.muted = true;
            AntiStall.start(video);
        }

        STATE.currentTitle = STATE.adapter.getCurrentTitle();
        addLog('🚀 开始刷课', 'info');
        updatePanel();

        // 启动主循环
        mainLoop();
    }

    /** 暂停 */
    function pauseRun() {
        STATE.isPaused = true;
        if (STATE.timerInterval) { clearInterval(STATE.timerInterval); STATE.timerInterval = null; }
        AntiStall.stop();
        addLog('⏸ 已暂停', 'info');
        updatePanel();
    }

    /** 恢复 */
    function resumeRun() {
        STATE.isPaused = false;
        STATE.startTime = Date.now() - STATE.elapsed * 1000;
        STATE.timerInterval = setInterval(() => {
            STATE.elapsed = Math.floor((Date.now() - STATE.startTime) / 1000);
            updatePanel();
        }, 1000);

        const video = STATE.adapter.detectVideo();
        if (video) {
            STATE.currentVideo = video;
            video.playbackRate = STATE.currentSpeed;
            if (Config.get('autoMute')) video.muted = true;
            AntiStall.start(video);
        }
        addLog('▶ 已恢复', 'info');
        updatePanel();
        mainLoop();
    }

    /** 停止所有 */
    /** 开始挂时长 */
    function startDurationRun() {
        if (!STATE.adapter) {
            addLog('未检测到支持的平台', 'error');
            return;
        }

        const totalMinutes = parseInt(document.getElementById('sca-duration-minutes').value) || Config.get('duration.totalMinutes');
        if (totalMinutes < 1) {
            addLog('请设置有效的挂机时长（至少1分钟）', 'error');
            return;
        }
        Config.set('duration.totalMinutes', totalMinutes);

        const ok = DurationEngine.init(STATE.adapter, totalMinutes);
        if (!ok) return;

        STATE.isRunning = true;
        STATE.isPaused = false;
        STATE.startTime = Date.now();
        STATE.elapsed = 0;
        STATE.completed = 0;
        STATE.remaining = DurationEngine.menuNodes.length;
        STATE.timerInterval = setInterval(() => {
            STATE.elapsed = Math.floor((Date.now() - STATE.startTime) / 1000);
            updatePanel();
        }, 1000);

        DurationEngine.start();
        updatePanel();
    }

    function stopAll() {
        STATE.isRunning = false;
        STATE.isPaused = false;
        if (STATE.timerInterval) { clearInterval(STATE.timerInterval); STATE.timerInterval = null; }
        if (STATE.mainLoopTimer) { clearTimeout(STATE.mainLoopTimer); STATE.mainLoopTimer = null; }
        AntiStall.stop();
        DurationEngine.stop();
        addLog('⏹ 已停止', 'info');
        updatePanel();
    }

    /** 重置 */
    function resetAll() {
        stopAll();
        STATE.completed = 0;
        STATE.remaining = 0;
        STATE.elapsed = 0;
        STATE.startTime = 0;
        STATE.answerStats = { ai: 0, web: 0, total: 0 };
        LOG_LINES.length = 0;
        DurationEngine.reset();
        document.getElementById('sca-bar').style.width = '0%';
        updatePanel();
        updateLogArea();
        addLog('🔄 已重置', 'info');
    }

    /** 静音切换 */
    function toggleMute() {
        const btn = document.getElementById('sca-btn-mute');
        if (STATE.currentVideo) {
            STATE.currentVideo.muted = !STATE.currentVideo.muted;
            btn.textContent = STATE.currentVideo.muted ? '🔇' : '🔊';
        }
    }

    // ================================================================
    //  9a. 主循环
    // ================================================================
    async function mainLoop() {
        if (!STATE.isRunning || STATE.isPaused) return;
        if (!STATE.adapter) {
            addLog('平台适配器丢失', 'error');
            return;
        }

        const adapter = STATE.adapter;

        try {
            // 1. 查找视频
            const video = adapter.detectVideo();
            if (video && video !== STATE.currentVideo) {
                STATE.currentVideo = video;
                video.playbackRate = STATE.currentSpeed;
                if (Config.get('autoMute')) video.muted = true;
                AntiStall.start(video);
                STATE.currentTitle = adapter.getCurrentTitle();
                video.addEventListener('ended', onVideoEnded);
            }

            // 2. 查找题目
            const questions = adapter.detectQuestions();
            if (questions.length > 0 && Config.get('autoAnswer')) {
                addLog(`检测到 ${questions.length} 道题目`, 'info');
                await handleQuestions(questions);
            }

            // 3. 查找"下一节"按钮
            if (!video || video.ended) {
                const nextBtn = adapter.getNextButton();
                if (nextBtn) {
                    addLog('点击下一节...', 'info');
                    nextBtn.click();
                    STATE.completed++;
                    STATE.remaining = Math.max(0, STATE.remaining - 1);
                    updatePanel();
                    STATE.mainLoopTimer = setTimeout(mainLoop, 3000);
                    return;
                }
            }

            // 4. 检查视频是否播放结束
            if (video && video.ended) {
                // 等待一小段时间看是否有自动跳转
                STATE.mainLoopTimer = setTimeout(mainLoop, 2000);
                return;
            }

            updatePanel();

        } catch (e) {
            addLog(`主循环异常: ${e.message}`, 'error');
        }

        // 继续循环
        STATE.mainLoopTimer = setTimeout(mainLoop, 2000);
    }

    /** 视频播放结束回调 */
    function onVideoEnded() {
        addLog('视频播放完成', 'success');
        STATE.completed++;
        STATE.remaining = Math.max(0, STATE.remaining - 1);
        STATE.currentVideo = null;
        AntiStall.stop();
        updatePanel();

        // 立即检查"下一节"按钮
        setTimeout(() => {
            const nextBtn = STATE.adapter.getNextButton();
            if (nextBtn) {
                addLog('自动跳转下一节', 'info');
                nextBtn.click();
            }
        }, 1000);
    }

    /** 处理题目 */
    async function handleQuestions(questions) {
        for (const q of questions) {
            if (!STATE.isRunning || STATE.isPaused) break;

            addLog(`题型: ${q.type === 'single' ? '单选' : q.type === 'multi' ? '多选' : q.type === 'judge' ? '判断' : '填空'}`, 'info');

            const result = await AIModule.search(q);
            if (result) {
                const filled = STATE.adapter.fillAnswer(q, result.answer);
                if (filled) {
                    addLog(`答案已填入: ${result.answer} (来源:${result.source})`, 'success');

                    // 自动提交
                    setTimeout(() => {
                        let clicked = false;
                        // 先尝试常见选择器
                        const submitSelectors = [
                            'button.submit', '.submit-btn', '#submitBtn',
                            'button[type="submit"]', '.btn-submit', '.btn_submit',
                            '.ant-btn-primary', '.el-button--primary',
                        ];
                        for (const sel of submitSelectors) {
                            const btn = document.querySelector(sel);
                            if (btn && btn.offsetParent !== null) {
                                const text = (btn.textContent || '').trim();
                                if (/提交|确认|确定/.test(text)) {
                                    try { btn.click(); addLog('已点击提交', 'info'); clicked = true; } catch (e) { }
                                    break;
                                }
                            }
                        }
                        // 文本匹配兜底
                        if (!clicked) {
                            const allBtns = document.querySelectorAll('button, .btn, a.btn, [role="button"]');
                            for (const btn of allBtns) {
                                if (btn.offsetParent === null) continue;
                                const text = (btn.textContent || btn.innerText || '').trim();
                                if (/^提交$|^确认$|^确定$|提交答案|确认提交/.test(text)) {
                                    try { btn.click(); addLog('已点击提交', 'info'); } catch (e) { }
                                    break;
                                }
                            }
                        }
                    }, 500);

                } else {
                    addLog(`答案填入失败: ${result.answer}`, 'warn');
                }
            }
        }
    }

    // ================================================================
    //  10. SPA 路由监听（单页应用切换页面时重新适配）
    // ================================================================
    function setupSPAMonitor() {
        let lastUrl = location.href;

        // 监听 history pushState / replaceState
        const _pushState = history.pushState;
        const _replaceState = history.replaceState;

        history.pushState = function () {
            _pushState.apply(this, arguments);
            onUrlChange();
        };
        history.replaceState = function () {
            _replaceState.apply(this, arguments);
            onUrlChange();
        };
        window.addEventListener('popstate', onUrlChange);
        window.addEventListener('hashchange', onUrlChange);

        function onUrlChange() {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            addLog(`页面切换: ${location.href.substring(0, 80)}`, 'info');

            // 延迟重新检测
            setTimeout(() => {
                if (STATE.isRunning && !STATE.isPaused) {
                    STATE.currentVideo = null;
                    AntiStall.stop();
                    const video = STATE.adapter.detectVideo();
                    if (video) {
                        STATE.currentVideo = video;
                        video.playbackRate = STATE.currentSpeed;
                        if (Config.get('autoMute')) video.muted = true;
                        AntiStall.start(video);
                    }
                    STATE.currentTitle = STATE.adapter.getCurrentTitle();
                    updatePanel();
                }
            }, 1500);
        }
    }

    // ================================================================
    //  11. 初始化
    // ================================================================
    function init() {
        Config.load();

        // 从持久化配置恢复
        STATE.targetSpeed = Config.get('playbackRate');
        STATE.currentSpeed = STATE.targetSpeed;

        // 平台检测
        const adapter = PlatformRegistry.detect();
        if (!adapter) {
            console.log('[刷课助手] 当前页面不是支持的平台');
            return;
        }

        // 创建 UI
        createPanel();

        // 应用已保存的模式
        refreshPanelMode();

        // 显示平台
        document.getElementById('sca-platform').textContent = adapter.label;

        // 初始化速度滑块
        const speedSlider = document.getElementById('sca-speed');
        if (speedSlider) {
            speedSlider.value = STATE.targetSpeed;
            document.getElementById('sca-speed-label').textContent = STATE.targetSpeed + 'x';
        }

        // SPA 监听
        setupSPAMonitor();

        updatePanel();
        addLog(`✅ 已就绪，当前平台: ${adapter.label}`, 'success');
        addLog('点击"开始刷课"启动', 'info');

        // 不自动启动——用户手动点击按钮
    }

    // 启动
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }

})();
