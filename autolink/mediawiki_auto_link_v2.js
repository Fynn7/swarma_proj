/**
 * @version 2.0
 * @author Swarma Community
 * @license MIT
 */

(function() {
    'use strict';
    
    // ==================== 配置 ====================
    const CONFIG = {
        API_URL: mw.config.get('wgScriptPath') + '/api.php',
        BUTTON_TEXT: '自动链接',
        UNDO_BUTTON_TEXT: '↶',
        NAMESPACE: 0, // 主命名空间
    };
    
    // ==================== 全局变量 ====================
    let allPageTitles = new Set();
    let originalText = '';
    let isProcessing = false;
    
    // ==================== 核心功能函数 ====================
    
    /**
     * 获取所有内部词条标题
     */
    async function fetchAllPages() {
        const pages = new Set();
        let apcontinue = null;
        let requestCount = 0;
        
        do {
            const params = {
                action: 'query',
                list: 'allpages',
                aplimit: 'max',
                apnamespace: CONFIG.NAMESPACE,
                format: 'json',
                origin: '*'
            };
            
            if (apcontinue) {
                params.apcontinue = apcontinue;
            }
            
            try {
                requestCount++;
                const response = await fetch(CONFIG.API_URL + '?' + new URLSearchParams(params));
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();
                
                if (data.query && data.query.allpages) {
                    data.query.allpages.forEach(page => {
                        pages.add(page.title);
                    });
                }
                
                apcontinue = data.continue ? data.continue.apcontinue : null;
                
                // 安全限制：最多请求100次
                if (requestCount > 100) {
                    break;
                }
                
            } catch (error) {
                console.error('AutoLink: 获取页面列表失败:', error);
                mw.notify('获取页面列表失败: ' + error.message, { type: 'error' });
                return pages;
            }
        } while (apcontinue);
        
        return pages;
    }
    
    /**
     * 保护已有的 MediaWiki 语法
     */
    function protectExistingSyntax(text) {
        const protectedParts = [];
        
        function protect(match) {
            protectedParts.push(match);
            return `__PROTECTED_${protectedParts.length - 1}__`;
        }
        
        // 保护各种语法
        const patterns = [
            /\[\[.*?\]\]/gs,           // 内部链接
            /\{\{.*?\}\}/gs,           // 模板
            /<.*?>.*?<\/.*?>/gs,       // HTML标签
            /<.*?\/>/g,                 // 自闭合标签
            /https?:\/\/[^\s]+/g,      // 外部链接
            /__[A-Z]+__/g              // 魔术字
        ];
        
        patterns.forEach(pattern => {
            text = text.replace(pattern, protect);
        });
        
        return { text, protectedParts };
    }
    
    /**
     * 恢复被保护的语法
     */
    function restoreProtectedSyntax(text, protectedParts) {
        protectedParts.forEach((part, index) => {
            text = text.replace(`__PROTECTED_${index}__`, part);
        });
        return text;
    }
    
    /**
     * 检查位置是否重叠
     */
    function isOverlapping(start, end, positions) {
        return positions.some(([posStart, posEnd]) => {
            return !(end <= posStart || start >= posEnd);
        });
    }
    
    /**
     * 处理文本，添加自动链接
     */
    function processText(text, pageTitles) {
        // 保护已有语法
        const { text: protectedText, protectedParts } = protectExistingSyntax(text);
        let processedText = protectedText;
        
        // 按长度降序排列词条
        const sortedTitles = Array.from(pageTitles).sort((a, b) => b.length - a.length);
        
        // 记录已替换位置
        const replacedPositions = [];
        let replacementCount = 0;
        
        // 遍历所有词条
        for (const title of sortedTitles) {
            // 跳过带命名空间的词条
            if (title.includes(':')) continue;
            
            // 转义正则特殊字符
            const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // 匹配词条（不在 [[ ]] 内）
            const pattern = new RegExp(`(?<!\\[\\[)${escapedTitle}(?!\\]\\])`, 'g');
            
            // 查找所有匹配
            let match;
            const matches = [];
            while ((match = pattern.exec(processedText)) !== null) {
                matches.push({ start: match.index, end: match.index + title.length });
            }
            
            // 从后向前替换
            for (let i = matches.length - 1; i >= 0; i--) {
                const { start, end } = matches[i];
                
                if (!isOverlapping(start, end, replacedPositions)) {
                    processedText = processedText.slice(0, start) + `[[${title}]]` + processedText.slice(end);
                    replacedPositions.push([start, end]);
                    replacementCount++;
                }
            }
        }
        
        // 恢复保护的语法
        processedText = restoreProtectedSyntax(processedText, protectedParts);
        
        return { processedText, replacementCount };
    }
    
    /**
     * 获取编辑框
     */
    function getEditBox() {
        // 尝试不同的编辑器
        return document.getElementById('wpTextbox1') || 
               document.querySelector('.oo-ui-inputWidget-input') || 
               document.querySelector('textarea[name="wpTextbox1"]') || 
               null;
    }
    
    /**
     * 更新编辑框内容
     */
    function updateEditBox(editBox, newText) {
        // 方法1: 使用 jQuery 的 textSelection API (MediaWiki 标准方式)
        if (typeof $ !== 'undefined' && $.fn.textSelection) {
            try {
                $(editBox).textSelection('setContents', newText);
            } catch (e) {
                // 降级到直接修改
                editBox.value = newText;
            }
        } else {
            editBox.value = newText;
        }
        
        // 触发多种事件确保编辑器同步
        editBox.dispatchEvent(new Event('input', { bubbles: true }));
        editBox.dispatchEvent(new Event('change', { bubbles: true }));
        editBox.dispatchEvent(new Event('keyup', { bubbles: true }));
        
        // jQuery 事件 (如果可用)
        if (typeof $ !== 'undefined') {
            try {
                $(editBox).trigger('input');
                $(editBox).trigger('change');
            } catch (e) {
                // 忽略错误
            }
        }
        
        // 让编辑框获得焦点，触发 UI 更新
        editBox.focus();
    }
    
    // ==================== 事件处理函数 ====================
    
    /**
     * 自动链接按钮点击处理
     */
    async function handleAutoLink() {
        if (isProcessing) {
            mw.notify('处理中，请稍候...', { type: 'warn' });
            return;
        }
        
        const editBox = getEditBox();
        if (!editBox) {
            mw.notify('未找到编辑框', { type: 'error' });
            return;
        }
        
        isProcessing = true;
        mw.notify('正在处理，请稍候...', { type: 'info' });
        
        try {
            // 保存原始文本
            originalText = editBox.value;
            
            // 如果还没有加载词条列表，先加载
            if (allPageTitles.size === 0) {
                mw.notify('首次使用，正在加载词条列表...', { type: 'info' });
                allPageTitles = await fetchAllPages();
            }
            
            // 处理文本
            const { processedText, replacementCount } = processText(originalText, allPageTitles);
            
            // 更新编辑框
            updateEditBox(editBox, processedText);
            
            mw.notify(`自动链接完成！共添加 ${replacementCount} 个链接`, { type: 'success' });
            
            // 显示撤销按钮
            const undoBtn = document.getElementById('autolink-undo-btn');
            if (undoBtn) {
                undoBtn.style.display = 'inline-block';
            }
            
        } catch (error) {
            console.error('AutoLink: 自动链接失败:', error);
            mw.notify('自动链接失败: ' + error.message, { type: 'error' });
        } finally {
            isProcessing = false;
        }
    }
    
    /**
     * 撤销按钮点击处理
     */
    function handleUndo() {
        const editBox = getEditBox();
        if (!editBox) {
            mw.notify('未找到编辑框', { type: 'error' });
            return;
        }
        
        if (!originalText) {
            mw.notify('没有可撤销的内容', { type: 'warn' });
            return;
        }
        
        // 恢复原始文本
        updateEditBox(editBox, originalText);
        
        mw.notify('已撤销自动链接', { type: 'success' });
        
        // 隐藏撤销按钮
        const undoBtn = document.getElementById('autolink-undo-btn');
        if (undoBtn) {
            undoBtn.style.display = 'none';
        }
    }
    
    // ==================== UI 构建函数 ====================
    
    /**
     * 添加按钮到工具栏
     */
    function addButtons() {
        // 检查按钮是否已存在
        if (document.getElementById('autolink-btn')) {
            return;
        }
        
        // 优先尝试添加到编辑框上方
        const editBox = getEditBox();
        if (editBox) {
            const buttonContainer = document.createElement('div');
            buttonContainer.style.marginBottom = '10px';
            buttonContainer.style.padding = '5px';
            buttonContainer.style.backgroundColor = '#f8f9fa';
            buttonContainer.style.border = '1px solid #a2a9b1';
            buttonContainer.style.borderRadius = '2px';
            buttonContainer.id = 'autolink-button-container';
            editBox.parentNode.insertBefore(buttonContainer, editBox);
            addButtonsToContainer(buttonContainer);
            return;
        }
        
        // 备用方案：查找工具栏位置
        const toolbar = document.getElementById('wikiEditor-ui-toolbar') ||
                       document.querySelector('.wikiEditor-ui-toolbar') ||
                       document.querySelector('#toolbar');
        
        if (!toolbar) {
            return;
        }
        
        const buttonContainer = document.createElement('div');
        buttonContainer.style.display = 'inline-block';
        buttonContainer.style.marginLeft = '10px';
        buttonContainer.id = 'autolink-button-container';
        
        toolbar.appendChild(buttonContainer);
        addButtonsToContainer(buttonContainer);
    }
    
    /**
     * 添加按钮到指定容器
     */
    function addButtonsToContainer(container) {
        // 自动链接按钮
        const autoLinkBtn = document.createElement('button');
        autoLinkBtn.id = 'autolink-btn';
        autoLinkBtn.textContent = CONFIG.BUTTON_TEXT;
        autoLinkBtn.type = 'button';
        autoLinkBtn.className = 'mw-ui-button mw-ui-progressive';
        autoLinkBtn.style.marginRight = '5px';
        autoLinkBtn.style.padding = '5px 10px';
        autoLinkBtn.style.cursor = 'pointer';
        
        // 绑定事件
        autoLinkBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            handleAutoLink();
        }, true);
        
        autoLinkBtn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            handleAutoLink();
            return false;
        };
        
        // 撤销按钮
        const undoBtn = document.createElement('button');
        undoBtn.id = 'autolink-undo-btn';
        undoBtn.textContent = CONFIG.UNDO_BUTTON_TEXT;
        undoBtn.type = 'button';
        undoBtn.className = 'mw-ui-button';
        undoBtn.style.display = 'none';
        undoBtn.style.padding = '5px 10px';
        undoBtn.style.cursor = 'pointer';
        
        undoBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            handleUndo();
        }, true);
        
        undoBtn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            handleUndo();
            return false;
        };
        
        container.appendChild(autoLinkBtn);
        container.appendChild(undoBtn);
    }
    
    // ==================== 初始化 ====================
    
    /**
     * 初始化脚本
     */
    function init() {
        // 只在编辑页面运行
        const action = mw.config.get('wgAction');
        if (action !== 'edit' && action !== 'submit') {
            return;
        }
        
        // 等待页面加载完成
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', addButtons);
        } else {
            // 延迟添加按钮，确保编辑器已加载
            setTimeout(addButtons, 1000);
        }
    }
    
    // 启动脚本
    init();
    
})();
