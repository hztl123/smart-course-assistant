// ==UserScript==
// @name         智能刷课助手 (OCS + U校园AI)
// @namespace    smart-course-assistant
// @version      2.0.0
// @description  超星/智慧树/职教云/中国大学MOOC（OCS引擎）+ U校园AI搜题（DeepSeek）
// @author       hztl (OCS by enncy, U校园AI by hztl)
// @match        *://*.chaoxing.com/*
// @match        *://mooc1-*.edu.cn/*
// @match        *://*.edu.cn/*mooc*
// @match        *://*.zhihuishu.com/*
// @match        *://*.zhihuishu.cn/*
// @match        *://*.icve.com.cn/*
// @match        *://*.icourse163.org/*
// @match        *://ucontent.unipus.cn/*
// @match        *://ipub.unipus.cn/*
// @match        *://ucloud.unipus.cn/*
// @icon         data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📚</text></svg>
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @grant        window.close
// @grant        window.focus
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

// ╔══════════════════════════════════════════════════════════════════╗
// ║  PART 1: OCS 引擎（超星/智慧树/职教云/中国大学MOOC）               ║
// ║  ────────────────────────────────────────────────────────────    ║
// ║  来源: Greasy Fork → OCS网课助手                                  ║
// ║  请从 Tampermonkey 复制你已安装的 OCS 脚本代码，                  ║
// ║  粘贴到下方 "OCS_CODE_HERE" 的位置。                              ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    // ================================================================
    //  OCS 代码 —— 请替换下面这行为完整的 OCS 脚本内容
    //  从 Tampermonkey → OCS网课助手 → 编辑 → 全选复制 → 粘贴到这里
    //  ⚠️ 只复制 (function() { ... })() 主体，不要复制 // ==UserScript== 头部
    // ================================================================
    // >>> OCS_CODE_HERE <<<
    console.log('[智能刷课助手] OCS 引擎未加载——请粘贴 OCS 脚本代码到此位置');
    // >>> END_OCS_CODE <<<

})();

// ╔══════════════════════════════════════════════════════════════════╗
// ║  PART 2: U校园 AI 搜题模块（DeepSeek 驱动）                       ║
// ║  ────────────────────────────────────────────────────────────    ║
// ║  作者: hztl                                                     ║
// ║  功能: 题目检测 → DeepSeek AI 推理 → 点击选项                    ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    // 只在 U校园 激活
    const HOST = location.hostname || '';
    if (!/unipus\.cn/.test(HOST)) return;

    // ================================================================
    //  1. 配置
    // ================================================================
    const DEFAULTS = {
        ai: {
            enabled: true,
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
        completed: 0,
        total: 0,
        remaining: 0,
        startTime: 0,
        elapsed: 0,
        timerInterval: null,
        currentTitle: '',
    };

    // ================================================================
    //  3. 持久化配置
    // ================================================================
    const Config = {
        _data: { ...DEFAULTS },
        load() {
            try {
                const saved = GM_getValue('sca_config', null);
                if (saved && typeof saved === 'object') {
                    this._data = deepMerge({ ...DEFAULTS }, saved);
                }
            } catch (e) { }
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
    //  4. 日志
    // ================================================================
    const LOG_LINES = [];
    const MAX_LOG = 200;

    function addLog(msg, type) {
        type = type || 'info';
        var time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        LOG_LINES.push({ time: time, msg: msg, type: type });
        if (LOG_LINES.length > MAX_LOG) LOG_LINES.shift();
        var prefix = type === 'error' ? '❌' : type === 'warn' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
        console.log('[U校园AI] ' + prefix + ' ' + msg);
        updateLogArea();
    }

    // ================================================================
    //  5. U校园 题目检测
    // ================================================================
    var UnipusDetector = {

        detectQuestions: function () {
            var questions = [];
            var seen = new Set();

            // ── 步骤1: 容器级检测 ──
            var containerSels = [
                '.question-wrapper', '.question-item', '[class*="question"]',
                '.exam-item', '.topic-item', '.test-item',
                '[class*="topic"]', '[class*="exam"]', '.ant-form-item',
                '.single-choose', '.multi-choose', '.judge-item', '.fill-item',
            ];
            var containers = document.querySelectorAll(containerSels.join(','));
            for (var ci = 0; ci < containers.length; ci++) {
                var container = containers[ci];
                if (seen.has(container)) continue;
                var q = this._parseQuestion(container);
                if (q && q.options.length >= 2) {
                    questions.push(q);
                    seen.add(container);
                }
            }

            // ── 步骤2: 全局搜索 ──
            if (questions.length === 0) {
                var q = this._parseQuestion(document.body);
                if (q && q.options.length >= 2) { questions.push(q); }
            }

            // ── 去重 ──
            var deduped = [];
            var seenStems = new Set();
            for (var di = 0; di < questions.length; di++) {
                var q = questions[di];
                var s = q.stem;
                // 过滤章节标题
                if (/^(Part|Section|Unit|Chapter)\s+[IVXⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ\d]+/i.test(s)) continue;
                if (/^(Directions|Instructions|Listening|Reading|Writing|Translation)/i.test(s)) continue;
                if (s.length < 10) continue;
                var key = s.substring(0, 40).toLowerCase();
                if (seenStems.has(key)) continue;
                seenStems.add(key);
                if (q.options.length < 2 || q.options.length > 8) continue;
                // 过滤复习页（过半是 selected 且无 question-common-abs-choice）
                var reviewCount = 0, realCount = 0;
                q.options.forEach(function (o) {
                    var c = (o.element && o.element.className || '').toString();
                    if (/\bselected\b/.test(c)) reviewCount++;
                    if (/\bquestion-common-abs-choice\b/.test(c)) realCount++;
                });
                if (realCount > 0 && realCount < q.options.length && reviewCount > 0) {
                    q.options = q.options.filter(function (o) {
                        return /\bquestion-common-abs-choice\b/.test((o.element && o.element.className || '').toString());
                    });
                }
                if (reviewCount >= q.options.length * 0.5 && realCount === 0) continue;
                deduped.push(q);
            }

            addLog('U校园检测: 原始' + questions.length + '题 → 去重' + deduped.length + '题', 'info');
            return deduped;
        },

        _parseQuestion: function (container, forceType) {
            if (!container) return null;

            // 提取题干
            var stem = '';
            var stemEl = container.querySelector('.question-stem, .stem, .q-title, h3, h4, [class*="stem"], [class*="title"], .topic-title, .question-name, .exam-title');
            if (stemEl) {
                stem = (stemEl.textContent || stemEl.innerText || '').replace(/\s+/g, ' ').trim();
            }
            if (!stem || stem.length < 2) {
                var text = (container.textContent || '').replace(/\s+/g, ' ').trim();
                stem = text.substring(0, 300);
            }
            if (!stem || stem.length < 2) return null;

            var type = forceType;
            var options = [];

            // ── 策略A: input[type=radio/checkbox] ──
            var allInputs = Array.from(container.querySelectorAll('input'));
            var radios = allInputs.filter(function (inp) { return inp.type === 'radio' || inp.classList.contains('ant-radio-input'); });
            var checks = allInputs.filter(function (inp) { return inp.type === 'checkbox' || inp.classList.contains('ant-checkbox-input'); });

            function collectOptions(elements) {
                elements.forEach(function (el, i) {
                    var target = el;
                    for (var j = 0; j < 5; j++) {
                        var t = (target.textContent || target.innerText || '').replace(/\s+/g, ' ').trim();
                        if (t.length > (el.textContent || '').length * 0.7) break;
                        target = target.parentElement;
                        if (!target) { target = el; break; }
                    }
                    var txt = (target.textContent || target.innerText || '').replace(/\s+/g, ' ').trim();
                    if (txt) {
                        options.push({ index: i, letter: String.fromCharCode(65 + i), text: txt, element: target });
                    }
                });
            }

            if (radios.length >= 2) { type = type || 'single'; collectOptions(radios); }
            if (checks.length >= 2) { type = type || 'multi'; collectOptions(checks); }
            if (options.length >= 2) return { type: type, stem: stem, options: options, container: container, raw: stem };

            // ── 策略B: Ant Design ──
            var antRadios = Array.from(container.querySelectorAll('.ant-radio-wrapper, .ant-radio'));
            var antChecks = Array.from(container.querySelectorAll('.ant-checkbox-wrapper, .ant-checkbox'));
            options = [];
            if (antRadios.length >= 2) { type = type || 'single'; collectOptions(antRadios); }
            if (antChecks.length >= 2 && options.length === 0) { type = type || 'multi'; collectOptions(antChecks); }
            if (options.length >= 2) return { type: type, stem: stem, options: options, container: container, raw: stem };

            // ── 策略C: U校园专属 question-common-abs-choice / option-wrap ──
            options = [];
            var unipusOpts = Array.from(container.querySelectorAll('.question-common-abs-choice, .option-wrap, [class*="common-abs-choice"], [class*="option-wrap"]'));
            if (unipusOpts.length >= 2 && unipusOpts.length <= 8) {
                var byClass = {};
                unipusOpts.forEach(function (el) {
                    var cls = (el.className || '').toString().split(' ').filter(function (c) {
                        return c && !/selected|checked|active|hover|focus/i.test(c);
                    }).sort().join(' ');
                    if (!byClass[cls]) byClass[cls] = [];
                    byClass[cls].push(el);
                });
                var groups = Object.values(byClass).sort(function (a, b) { return b.length - a.length; });
                var largest = groups[0];
                if (largest && largest.length >= 2 && largest.length <= 6) {
                    type = type || 'single';
                    var sorted = _sortByVisualOrder(largest);
                    sorted.forEach(function (el, i) {
                        var txt = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
                        if (txt) options.push({ index: i, letter: String.fromCharCode(65 + i), text: txt, element: el });
                    });
                }
                if (options.length >= 2) return { type: type, stem: stem, options: options, container: container, raw: stem };
            }

            // ── 策略D: 文字模式 A. B. C. D. ──
            options = [];
            var letterPattern = container.querySelectorAll('[class*="option"], [class*="choice"], li, .item, [data-index]');
            var letterOptions = [];
            for (var li = 0; li < letterPattern.length; li++) {
                var el = letterPattern[li];
                var txt = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
                if (/^[A-Da-d][.\s、:：)]/.test(txt) || /^[1-4][.\s、:：)]/.test(txt)) {
                    letterOptions.push({ el: el, text: txt });
                }
            }
            if (letterOptions.length >= 2 && letterOptions.length <= 10) {
                type = type || 'single';
                letterOptions.forEach(function (item, i) {
                    options.push({ index: i, letter: String.fromCharCode(65 + i), text: item.text, element: item.el });
                });
                return { type: type, stem: stem, options: options, container: container, raw: stem };
            }

            // ── 策略E: 判断题 ──
            options = [];
            var allBtns = container.querySelectorAll('button, .btn, a, span[role="button"]');
            var judgeItems = [];
            for (var bi = 0; bi < allBtns.length; bi++) {
                var btn = allBtns[bi];
                var t = (btn.textContent || '').trim();
                if (/^(正确|错误|对|错|是|否|√|×|true|false|yes|no)$/i.test(t)) {
                    judgeItems.push({ element: btn, text: t });
                }
            }
            if (judgeItems.length >= 2) {
                type = 'judge';
                var tItem = judgeItems.filter(function (j) { return /正确|对|是|√|true|yes/i.test(j.text); })[0];
                var fItem = judgeItems.filter(function (j) { return /错误|错|否|×|false|no/i.test(j.text); })[0];
                if (tItem) options.push({ index: 0, letter: 'A', text: '正确', element: tItem.element });
                if (fItem) options.push({ index: 1, letter: 'B', text: '错误', element: fItem.element });
                if (options.length >= 2) return { type: type, stem: stem, options: options, container: container, raw: stem };
            }

            // ── 策略F: 填空 ──
            var textInputs = container.querySelectorAll('input[type="text"], input:not([type]), textarea, [contenteditable="true"]');
            if (textInputs.length > 0 && !forceType) {
                return { type: 'fill', stem: stem, options: [], container: container, raw: stem, inputs: Array.from(textInputs) };
            }

            return null;
        },

        fillAnswer: function (question, answer) {
            if (!answer) return false;
            var ans = String(answer).trim();
            addLog('fillAnswer: type=' + question.type + ' answer="' + ans + '" opts=' + question.options.length, 'info');
            try {
                if (question.type === 'single' || question.type === 'multi') {
                    return this._fillChoice(question, ans);
                } else if (question.type === 'judge') {
                    return this._fillJudge(question, ans);
                } else if (question.type === 'fill') {
                    return this._fillBlank(question, ans);
                } else {
                    return this._fillChoice(question, ans);
                }
            } catch (e) {
                addLog('填入异常: ' + e.message, 'error');
                return false;
            }
        },

        _fillChoice: function (question, answer) {
            var letters = (answer.match(/[A-Za-z]/g) || []).map(function (l) { return l.toUpperCase(); });
            if (question.type === 'single' && letters.length > 1) {
                addLog('  → AI返回多字母"' + answer + '"，单选只取"' + letters[0] + '"', 'warn');
                letters = [letters[0]];
            }
            addLog('_fillChoice: letters=' + letters.join(',') + ' opts=' + question.options.map(function (o) { return o.letter; }).join(','), 'info');

            if (letters.length === 0) return this._fillByTextMatch(question, answer);

            var filled = false;
            var skipped = false;
            for (var li = 0; li < letters.length; li++) {
                var letter = letters[li];
                var opt = question.options.filter(function (o) { return o.letter === letter; })[0];
                if (opt && opt.element) {
                    var clicked = this._clickElement(opt.element);
                    if (clicked) {
                        filled = true;
                        addLog('点击选项 ' + letter + ': <' + opt.element.tagName + '> class="' + (opt.element.className || '').toString().substring(0, 30) + '"', 'info');
                    } else {
                        skipped = true;
                        addLog('选项 ' + letter + ' 已选中，跳过', 'info');
                    }
                } else {
                    addLog('未找到选项 ' + letter, 'warn');
                }
            }

            if (!filled && !skipped) {
                addLog('字母匹配失败，尝试文字匹配...', 'warn');
                return this._fillByTextMatch(question, answer);
            }
            // 全部跳过（已选中）也算"处理了"
            return filled || skipped;
        },

        _fillByTextMatch: function (question, answer) {
            var cleanAns = answer.replace(/^[A-Za-z][.\s、:：)]*/, '').trim();
            for (var oi = 0; oi < question.options.length; oi++) {
                var opt = question.options[oi];
                var optText = opt.text.replace(/^[A-Za-z][.\s、:：)]*/, '').trim();
                if (optText.indexOf(cleanAns) !== -1 || cleanAns.indexOf(optText) !== -1) {
                    if (opt.element) {
                        this._clickElement(opt.element);
                        return true;
                    }
                }
            }
            return false;
        },

        _fillJudge: function (question, answer) {
            var isTrue = /正确|对|是|√|true|yes|A|a/i.test(answer);
            var target = isTrue ? question.options[0] : question.options[1];
            if (target && target.element) { this._clickElement(target.element); return true; }
            return false;
        },

        _fillBlank: function (question, answer) {
            var inputs = question.inputs || question.container.querySelectorAll('input[type="text"], input:not([type]), textarea, [contenteditable="true"]');
            if (inputs.length === 0) return false;
            var parts = answer.split(/[,;，；\s|]+/).filter(Boolean);
            for (var ii = 0; ii < inputs.length; ii++) {
                if (ii < parts.length) {
                    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                    if (nativeSetter && nativeSetter.set) {
                        nativeSetter.set.call(inputs[ii], parts[ii]);
                    } else {
                        inputs[ii].value = parts[ii];
                    }
                    inputs[ii].dispatchEvent(new Event('input', { bubbles: true }));
                    inputs[ii].dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            return true;
        },

        _clickElement: function (el) {
            if (!el) return false;
            // 已选中的跳过，返回 false
            try {
                var cls = (el.className || '').toString();
                if (/\bselected\b/.test(cls)) return false;
            } catch (e) { }
            try {
                // 策略1: 内部可交互子元素
                var inners = el.querySelectorAll('input, label, span, a, button, [class*="inner"], [class*="radio"], [class*="check"]');
                for (var ii = 0; ii < inners.length; ii++) {
                    try {
                        if (typeof inners[ii].click === 'function') inners[ii].click();
                        inners[ii].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    } catch (e) { }
                }
                // 策略2: 元素本身
                if (typeof el.click === 'function') el.click();
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                // 策略3: 父元素链
                var p = el.parentElement;
                for (var pi = 0; pi < 4 && p; pi++) {
                    try {
                        if (typeof p.click === 'function' && p !== document.body) p.click();
                    } catch (e) { }
                    p = p.parentElement;
                }
                return true;
            } catch (e) {
                addLog('点击异常: ' + e.message, 'warn');
                return false;
            }
        },

        getCurrentTitle: function () {
            var el = document.querySelector('.exam-title, .paper-title, h1, h2, .title');
            return el ? (el.textContent || '').trim() : document.title;
        },
    };

    function _sortByVisualOrder(elements) {
        return Array.from(elements).sort(function (a, b) {
            var ra = a.getBoundingClientRect();
            var rb = b.getBoundingClientRect();
            var dy = ra.top - rb.top;
            if (Math.abs(dy) > 10) return dy;
            return ra.left - rb.left;
        });
    }

    // ================================================================
    //  6. AI 搜题模块 (DeepSeek)
    // ================================================================
    var AIModule = {
        searchViaAI: function (question, retryCount) {
            retryCount = retryCount || 0;
            var apiKey = Config.get('ai.apiKey');
            var baseUrl = Config.get('ai.baseUrl');
            var model = Config.get('ai.model');

            if (!apiKey) { addLog('AI搜题: 未配置API Key', 'warn'); return Promise.resolve(null); }

            var prompt = this._buildPrompt(question);
            var self = this;

            return new Promise(function (resolve) {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: baseUrl,
                    timeout: Config.get('ai.timeout') || 15000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + apiKey,
                    },
                    data: JSON.stringify({
                        model: model,
                        messages: [
                            { role: 'system', content: '你是答题机器人。严格按以下规则输出，不得输出任何其他内容：\n- 单选题：输出1个大写字母(A/B/C/D/E)\n- 多选题：输出字母连写(如ABC)\n- 判断题：输出"正确"或"错误"\n- 填空题：输出答案文本(多空用;分隔)' },
                            { role: 'user', content: prompt },
                        ],
                        temperature: 0.1,
                    }),
                    onload: function (resp) {
                        try {
                            var res = JSON.parse(resp.responseText);
                            if (res.choices && res.choices[0]) {
                                var msg = res.choices[0].message;
                                var raw = (msg.content || msg.reasoning_content || '').trim();
                                // 清洗管道
                                var answer = raw
                                    .split(/\n|\r\n/)[0]
                                    .replace(/^(答案[是为：:]\s*)/i, '')
                                    .replace(/^(正确选项[是为：:]\s*)/i, '')
                                    .replace(/^(选\s*)/i, '')
                                    .replace(/^["'`]|["'`]$/g, '')
                                    .replace(/[.,。，、]\s*$/, '')
                                    .replace(/\s+/g, '')
                                    .trim();
                                // 提取字母
                                if (question.type === 'single' || question.type === 'multi') {
                                    var letters = (answer.match(/[A-Ea-e]/g) || []).map(function (l) { return l.toUpperCase(); });
                                    if (letters.length > 0) {
                                        if (question.type === 'single') {
                                            answer = letters[0];
                                        } else {
                                            var unique = [];
                                            letters.forEach(function (l) { if (unique.indexOf(l) === -1) unique.push(l); });
                                            answer = unique.sort().join('');
                                        }
                                    }
                                }
                                if (!answer) {
                                    addLog('AI空: finish=' + res.choices[0].finish_reason + ' content="' + (msg.content || '').substring(0, 60) + '"', 'warn');
                                    if (retryCount < 1) {
                                        addLog('  → AI返回空，1秒后重试...', 'warn');
                                        setTimeout(function () {
                                            self.searchViaAI(question, retryCount + 1).then(resolve);
                                        }, 1000);
                                        return;
                                    }
                                }
                                resolve({ answer: answer, confidence: answer ? 0.85 : 0, source: 'AI' });
                            } else {
                                addLog('AI返回异常: ' + JSON.stringify(res).substring(0, 200), 'warn');
                                resolve(null);
                            }
                        } catch (e) {
                            addLog('AI解析失败: ' + e.message, 'warn');
                            resolve(null);
                        }
                    },
                    onerror: function () { addLog('AI网络失败', 'warn'); resolve(null); },
                    ontimeout: function () { addLog('AI超时', 'warn'); resolve(null); },
                });
            });
        },

        _buildPrompt: function (question) {
            var prompt = '';
            switch (question.type) {
                case 'single':
                    prompt = '请回答以下单选题，只输出正确答案的字母（如 A）。\n题目：' + question.stem + '\n';
                    question.options.forEach(function (o) { prompt += o.letter + '. ' + o.text.substring(0, 80) + '\n'; });
                    break;
                case 'multi':
                    prompt = '请回答以下多选题，只输出所有正确答案的字母（如 ABC）。\n题目：' + question.stem + '\n';
                    question.options.forEach(function (o) { prompt += o.letter + '. ' + o.text.substring(0, 80) + '\n'; });
                    break;
                case 'judge':
                    prompt = '请判断以下说法是否正确，只输出"正确"或"错误"。\n' + question.stem;
                    break;
                case 'fill':
                    prompt = '请回答以下填空题，只输出答案内容，多个空用分号;分隔。\n' + question.stem;
                    break;
                default:
                    prompt = '请回答以下题目：\n' + question.stem;
                    if (question.options.length > 0) {
                        question.options.forEach(function (o) { prompt += o.letter + '. ' + o.text.substring(0, 80) + '\n'; });
                    }
            }
            return prompt;
        },
    };

    // ================================================================
    //  7. UI 面板
    // ================================================================
    var PANEL_ID = 'sca-panel';

    GM_addStyle([
        '#' + PANEL_ID + '{position:fixed;top:80px;right:16px;z-index:99999;width:300px;max-height:80vh;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.18);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;color:#333;overflow:hidden;user-select:none;}',
        '#sca-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f8f9fa;border-bottom:1px solid #eee;cursor:move;font-weight:600;font-size:14px;}',
        '#sca-header .sca-btns{display:flex;gap:6px;}',
        '#sca-header .sca-btns button{width:24px;height:24px;border:none;border-radius:4px;background:transparent;cursor:pointer;font-size:14px;color:#666;}',
        '#sca-header .sca-btns button:hover{background:#e0e0e0;}',
        '#sca-body{padding:12px;max-height:calc(80vh - 48px);overflow-y:auto;}',
        '.sca-status{display:flex;align-items:center;gap:8px;margin-bottom:10px;}',
        '.sca-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}',
        '.sca-dot.running{background:#4caf50;animation:sca-pulse 1.5s ease-in-out infinite;}',
        '.sca-dot.paused{background:#ff9800;}',
        '.sca-dot.done{background:#2196f3;}',
        '.sca-dot.idle{background:#bbb;}',
        '@keyframes sca-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
        '.sca-progress{height:6px;background:#eee;border-radius:3px;margin-bottom:10px;overflow:hidden;}',
        '.sca-progress-bar{height:100%;background:linear-gradient(90deg,#4caf50,#8bc34a);border-radius:3px;transition:width 0.5s;}',
        '.sca-stats{display:flex;gap:8px;margin-bottom:10px;}',
        '.sca-stat{flex:1;text-align:center;background:#f5f5f5;border-radius:8px;padding:8px 4px;}',
        '.sca-stat-val{font-size:18px;font-weight:700;color:#333;}',
        '.sca-stat-label{font-size:10px;color:#999;margin-top:2px;}',
        '.sca-current{margin-bottom:10px;padding:8px 10px;background:#fff9e6;border-radius:6px;font-size:12px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.sca-btns-row{display:flex;gap:6px;margin-bottom:10px;}',
        '.sca-btn{flex:1;min-width:60px;padding:7px 0;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;}',
        '.sca-btn.primary{background:#4caf50;color:#fff;}',
        '.sca-btn.primary:hover{background:#43a047;}',
        '.sca-btn.primary.running{background:#ff9800;}',
        '.sca-btn.default{background:#f0f0f0;color:#333;}',
        '.sca-btn.default:hover{background:#e0e0e0;}',
        '.sca-log{margin-top:8px;}',
        '.sca-log-toggle{font-size:12px;color:#999;cursor:pointer;margin-bottom:4px;}',
        '.sca-log-area{max-height:150px;overflow-y:auto;font-size:11px;background:#fafafa;border-radius:6px;padding:6px 8px;display:none;}',
        '.sca-log-area.show{display:block;}',
        '.sca-log-line{padding:2px 0;border-bottom:1px solid #f0f0f0;display:flex;gap:6px;}',
        '.sca-log-time{color:#bbb;flex-shrink:0;}',
        '.sca-log-msg.info{color:#666;}',
        '.sca-log-msg.success{color:#4caf50;}',
        '.sca-log-msg.warn{color:#ff9800;}',
        '.sca-log-msg.error{color:#f44336;}',
        '.sca-settings{margin-top:8px;}',
        '.sca-settings-toggle{font-size:12px;color:#999;cursor:pointer;}',
        '.sca-settings-body{display:none;margin-top:6px;}',
        '.sca-settings-body.show{display:block;}',
        '.sca-setting-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:12px;}',
        '.sca-setting-row input[type=text]{width:160px;padding:4px 6px;border:1px solid #ddd;border-radius:4px;font-size:11px;}',
        '.sca-setting-row input[type=checkbox]{margin:0;}',
    ].join('\n'));

    function createPanel() {
        if (document.getElementById(PANEL_ID)) return;
        var panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = [
            '<div id="sca-header">',
            '  <span>📚 U校园AI搜题</span>',
            '  <div class="sca-btns">',
            '    <button id="sca-btn-min" title="最小化">−</button>',
            '    <button id="sca-btn-close" title="关闭">×</button>',
            '  </div>',
            '</div>',
            '<div id="sca-body">',
            '  <div class="sca-status">',
            '    <span class="sca-dot idle" id="sca-dot"></span>',
            '    <span id="sca-status-text">待命中</span>',
            '  </div>',
            '  <div class="sca-progress"><div class="sca-progress-bar" id="sca-bar" style="width:0%"></div></div>',
            '  <div class="sca-stats">',
            '    <div class="sca-stat"><div class="sca-stat-val" id="sca-done">0</div><div class="sca-stat-label">已完成</div></div>',
            '    <div class="sca-stat"><div class="sca-stat-val" id="sca-left">--</div><div class="sca-stat-label">剩余</div></div>',
            '    <div class="sca-stat"><div class="sca-stat-val" id="sca-time">00:00</div><div class="sca-stat-label">用时</div></div>',
            '  </div>',
            '  <div class="sca-current" id="sca-title">等待开始...</div>',
            '  <div class="sca-btns-row">',
            '    <button class="sca-btn primary" id="sca-btn-start">▶ 开始刷题</button>',
            '    <button class="sca-btn default" id="sca-btn-reset" style="flex:0;min-width:auto;padding:7px 10px;">↻</button>',
            '  </div>',
            '  <div class="sca-log">',
            '    <div style="display:flex;align-items:center;gap:8px;">',
            '      <div class="sca-log-toggle" id="sca-log-toggle">📋 日志 ▸</div>',
            '      <button id="sca-btn-copy-log" style="margin-left:auto;font-size:10px;padding:2px 6px;border:1px solid #ddd;border-radius:3px;background:#f5f5f5;cursor:pointer;display:none;">📋 复制</button>',
            '    </div>',
            '    <div class="sca-log-area" id="sca-log-area"></div>',
            '  </div>',
            '  <div class="sca-settings">',
            '    <div class="sca-settings-toggle" id="sca-settings-toggle">⚙ 设置 ▸</div>',
            '    <div class="sca-settings-body" id="sca-settings-body">',
            '      <div class="sca-setting-row">',
            '        <span>API Key</span>',
            '        <input type="text" id="sca-cfg-ai-key" value="' + escapeHtml(Config.get('ai.apiKey') || '') + '" placeholder="sk-xxx">',
            '      </div>',
            '      <div class="sca-setting-row">',
            '        <span>模型</span>',
            '        <input type="text" id="sca-cfg-ai-model" value="' + escapeHtml(Config.get('ai.model') || '') + '" placeholder="deepseek-chat">',
            '      </div>',
            '    </div>',
            '  </div>',
            '</div>',
        ].join('');
        document.body.appendChild(panel);
        bindPanelEvents();
    }

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function bindPanelEvents() {
        initDrag();

        document.getElementById('sca-btn-min').addEventListener('click', function () {
            var body = document.getElementById('sca-body');
            var panel = document.getElementById(PANEL_ID);
            if (body.style.display === 'none') {
                body.style.display = '';
                panel.style.width = '300px';
                document.getElementById('sca-btn-min').textContent = '−';
            } else {
                body.style.display = 'none';
                panel.style.width = 'auto';
                document.getElementById('sca-btn-min').textContent = '+';
            }
        });

        document.getElementById('sca-btn-close').addEventListener('click', function () {
            stopAll();
            document.getElementById(PANEL_ID).style.display = 'none';
        });

        document.getElementById('sca-btn-start').addEventListener('click', function () {
            if (STATE.isRunning) {
                stopAll();
            } else {
                startRun();
            }
        });

        document.getElementById('sca-btn-reset').addEventListener('click', resetAll);

        document.getElementById('sca-log-toggle').addEventListener('click', function () {
            var area = document.getElementById('sca-log-area');
            var copyBtn = document.getElementById('sca-btn-copy-log');
            var show = !area.classList.contains('show');
            area.classList.toggle('show');
            this.textContent = show ? '📋 日志 ▾' : '📋 日志 ▸';
            if (copyBtn) copyBtn.style.display = show ? 'inline' : 'none';
        });

        document.getElementById('sca-btn-copy-log').addEventListener('click', function () {
            var text = LOG_LINES.map(function (l) { return '[' + l.time + '] ' + l.msg; }).join('\n');
            navigator.clipboard.writeText(text).then(function () {
                addLog('✅ 日志已复制', 'success');
            }).catch(function () {
                addLog('请手动 Ctrl+C 复制', 'info');
            });
        });

        document.getElementById('sca-settings-toggle').addEventListener('click', function () {
            var body = document.getElementById('sca-settings-body');
            var show = !body.classList.contains('show');
            body.classList.toggle('show');
            this.textContent = show ? '⚙ 设置 ▾' : '⚙ 设置 ▸';
        });

        document.getElementById('sca-cfg-ai-key').addEventListener('change', function () {
            Config.set('ai.apiKey', this.value.trim());
            addLog('API Key 已保存', 'info');
        });

        document.getElementById('sca-cfg-ai-model').addEventListener('change', function () {
            Config.set('ai.model', this.value.trim());
        });
    }

    function initDrag() {
        var header = document.getElementById('sca-header');
        var panel = document.getElementById(PANEL_ID);
        var isDragging = false, startX, startY, startLeft, startTop;

        header.addEventListener('mousedown', function (e) {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            startX = e.clientX; startY = e.clientY;
            var rect = panel.getBoundingClientRect();
            startLeft = rect.left; startTop = rect.top;
            panel.style.transition = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!isDragging) return;
            panel.style.right = 'auto';
            panel.style.left = Math.min(Math.max(startLeft + e.clientX - startX, 0), window.innerWidth - panel.offsetWidth) + 'px';
            panel.style.top = Math.min(Math.max(startTop + e.clientY - startY, 0), window.innerHeight - 48) + 'px';
        });

        document.addEventListener('mouseup', function () {
            if (isDragging) { isDragging = false; panel.style.transition = ''; }
        });
    }

    function updateLogArea() {
        var area = document.getElementById('sca-log-area');
        if (!area) return;
        var recent = LOG_LINES.slice(-30);
        area.innerHTML = recent.map(function (l) {
            return '<div class="sca-log-line"><span class="sca-log-time">' + l.time + '</span><span class="sca-log-msg ' + l.type + '">' + escapeHtml(l.msg) + '</span></div>';
        }).join('');
        area.scrollTop = area.scrollHeight;
    }

    function updatePanel() {
        var dot = document.getElementById('sca-dot');
        if (!dot) return;
        var statusText = document.getElementById('sca-status-text');
        var btnStart = document.getElementById('sca-btn-start');

        dot.className = 'sca-dot';
        if (STATE.isRunning) {
            dot.classList.add('running');
            statusText.textContent = '运行中';
            btnStart.textContent = '⏸ 停止';
            btnStart.classList.add('running');
        } else if (STATE.completed > 0 && STATE.remaining === 0) {
            dot.classList.add('done');
            statusText.textContent = '全部完成';
            btnStart.textContent = '▶ 开始刷题';
            btnStart.classList.remove('running');
        } else {
            dot.classList.add('idle');
            statusText.textContent = '待命中';
            btnStart.textContent = '▶ 开始刷题';
            btnStart.classList.remove('running');
        }

        document.getElementById('sca-done').textContent = STATE.completed;
        document.getElementById('sca-left').textContent = STATE.remaining > 0 ? STATE.remaining : '--';
        document.getElementById('sca-time').textContent = formatTime(STATE.elapsed);
        document.getElementById('sca-title').textContent = STATE.currentTitle || '等待开始...';

        var bar = document.getElementById('sca-bar');
        if (STATE.remaining > 0 || STATE.completed > 0) {
            var total = STATE.completed + STATE.remaining;
            bar.style.width = total > 0 ? Math.round((STATE.completed / total) * 100) + '%' : '0%';
        } else {
            bar.style.width = '0%';
        }
    }

    function formatTime(seconds) {
        var m = Math.floor(seconds / 60);
        var s = Math.floor(seconds % 60);
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    // ================================================================
    //  8. 核心引擎
    // ================================================================
    function startRun() {
        STATE.isRunning = true;
        STATE.startTime = Date.now();
        STATE.elapsed = 0;
        STATE.completed = 0;
        STATE.remaining = 0;

        STATE.timerInterval = setInterval(function () {
            STATE.elapsed = Math.floor((Date.now() - STATE.startTime) / 1000);
            updatePanel();
        }, 1000);

        STATE.currentTitle = UnipusDetector.getCurrentTitle();
        addLog('🚀 开始刷题', 'info');
        updatePanel();
        processAllQuestions();
    }

    function stopAll() {
        STATE.isRunning = false;
        if (STATE.timerInterval) { clearInterval(STATE.timerInterval); STATE.timerInterval = null; }
        addLog('⏹ 已停止', 'info');
        updatePanel();
    }

    function resetAll() {
        stopAll();
        STATE.completed = 0;
        STATE.remaining = 0;
        STATE.elapsed = 0;
        STATE.startTime = 0;
        LOG_LINES.length = 0;
        document.getElementById('sca-bar').style.width = '0%';
        updatePanel();
        updateLogArea();
        addLog('🔄 已重置', 'info');
    }

    async function processAllQuestions() {
        var questions = UnipusDetector.detectQuestions();
        if (questions.length === 0) {
            addLog('未检测到题目', 'warn');
            stopAll();
            return;
        }

        STATE.total = questions.length;
        STATE.remaining = questions.length;
        addLog('检测到 ' + questions.length + ' 道题目，开始作答...', 'info');
        updatePanel();

        for (var qi = 0; qi < questions.length; qi++) {
            if (!STATE.isRunning) break;

            try {
                var q = questions[qi];
                var qLabel = q.stem.replace(/\s+/g, ' ').trim().substring(0, 40);
                var typeLabel = q.type === 'single' ? '单选' : q.type === 'multi' ? '多选' : q.type === 'judge' ? '判断' : '填空';
                addLog('Q' + (qi + 1) + '/' + questions.length + ' [' + typeLabel + '] ' + qLabel, 'info');

                var titleEl = document.getElementById('sca-title');
                if (titleEl) titleEl.textContent = 'AI思考中: ' + qLabel + '...';

                // AI 搜题
                var result = await AIModule.searchViaAI(q);
                if (!result) {
                    addLog('Q' + (qi + 1) + ' ❌ AI未返回答案', 'warn');
                    continue;
                }

                // 刷新 DOM 引用
                var freshQ = q;
                try {
                    var freshQuestions = UnipusDetector.detectQuestions();
                    if (freshQuestions.length > 0) {
                        var qKey = q.stem.replace(/\s+/g, '').substring(0, 30).toLowerCase();
                        var match = null;
                        for (var fi = 0; fi < freshQuestions.length; fi++) {
                            if (freshQuestions[fi].stem.replace(/\s+/g, '').substring(0, 30).toLowerCase() === qKey) {
                                match = freshQuestions[fi];
                                break;
                            }
                        }
                        if (match) { freshQ = match; }
                    }
                } catch (e) { /* 降级用原引用 */ }

                var filled = UnipusDetector.fillAnswer(freshQ, result.answer);
                if (filled) {
                    STATE.completed++;
                    STATE.remaining = Math.max(0, STATE.remaining - 1);
                    updatePanel();
                    addLog('Q' + (qi + 1) + ' ✅ 已填入: ' + result.answer + ' | ' + qLabel, 'success');
                } else {
                    addLog('Q' + (qi + 1) + ' ❌ 填入失败: ' + result.answer + ' | ' + qLabel, 'warn');
                }

                // 题目间短暂延迟，避免 API 限流
                if (qi < questions.length - 1 && STATE.isRunning) {
                    await sleep(800);
                }
            } catch (e) {
                addLog('Q' + (qi + 1) + ' 💥 异常: ' + e.message + '，继续下一题', 'error');
            }
        }

        if (STATE.isRunning) {
            STATE.currentTitle = '全部完成！';
            updatePanel();
            addLog('✅ 全部 ' + STATE.completed + ' 题处理完毕', 'success');
            stopAll();
        }
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // ================================================================
    //  9. 初始化
    // ================================================================
    function init() {
        Config.load();
        createPanel();
        updatePanel();
        addLog('✅ U校园AI模块已就绪', 'success');
        addLog('在面板设置中填入 DeepSeek API Key，点击"开始刷题"', 'info');
    }

    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }

})();
