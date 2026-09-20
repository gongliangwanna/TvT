// --- 教程与备份功能 (js/modules/tutorial.js) ---

function setupTutorialApp() {
    const tutorialContentArea = document.getElementById('tutorial-content-area');
    tutorialContentArea.addEventListener('click', (e) => {
        const header = e.target.closest('.tutorial-header') || 
                       e.target.closest('.tutorial-modern-header') || 
                       e.target.closest('.tutorial-rabbit-card-title');
        if (header) {
            header.parentElement.classList.toggle('open');
        }
    });
}

function renderUpdateLog(container) {
    const tutorialContent = container || document.getElementById('tutorial-content-area');
    if (!tutorialContent) return;
    const mode = typeof getAppearanceMode === 'function' ? getAppearanceMode() : 'classic';

    if (mode === 'rabbit') {
        const btn = document.createElement('button');
        btn.className = 'tutorial-rabbit-update-btn';
        btn.innerHTML = '查看更新日志';
        
        let notesHtml = '';
        updateLog.forEach((log, index) => {
            notesHtml += `
                <div style="margin-bottom: 15px; ${index < updateLog.length - 1 ? 'padding-bottom: 10px; border-bottom: 1px dashed #f5f0f1;' : ''}">
                    <h4 style="font-size: 15px; color: #555; margin: 0 0 5px 0;">版本 ${log.version} (${log.date})</h4>
                    <ul style="padding-left: 20px; margin: 0; list-style-type: '· ';">
                        ${log.notes.map(note => `<li style="margin-bottom: 5px; color: #666;">${note}</li>`).join('')}
                    </ul>
                </div>
            `;
        });

        const modal = document.createElement('div');
        modal.className = 'rabbit-update-modal';
        modal.innerHTML = `
            <div class="rabbit-update-content">
                <span class="rabbit-update-close-x">&times;</span>
                <h3 style="text-align:center; color:#555; margin-top:0;">更新日志</h3>
                ${notesHtml}
                <button class="rabbit-update-close">关闭</button>
            </div>
        `;
        document.body.appendChild(modal);

        btn.onclick = () => modal.classList.add('show');
        modal.querySelector('.rabbit-update-close').onclick = () => modal.classList.remove('show');
        modal.querySelector('.rabbit-update-close-x').onclick = () => modal.classList.remove('show');
        
        tutorialContent.appendChild(btn);
        return;
    }

    const isModern = mode === 'modern';
    const updateSection = document.createElement('div');
    updateSection.className = isModern ? 'tutorial-modern-item' : 'tutorial-item'; 

    let notesHtml = '';
    updateLog.forEach((log, index) => {
        notesHtml += `
            <div style="margin-bottom: 15px; ${index < updateLog.length - 1 ? 'padding-bottom: 10px; border-bottom: 1px solid #f0f0f0;' : ''}">
                <h4 style="font-size: 15px; color: #333; margin: 0 0 5px 0;">版本 ${log.version} (${log.date})</h4>
                <ul style="padding-left: 20px; margin: 0; list-style-type: '› ';">
                    ${log.notes.map(note => `<li style="margin-bottom: 5px; color: #666;">${note}</li>`).join('')}
                </ul>
            </div>
        `;
    });

    updateSection.innerHTML = `
        <div class="${isModern ? 'tutorial-modern-header' : 'tutorial-header'}">更新日志</div>
        <div class="${isModern ? 'tutorial-modern-content' : 'tutorial-content'}">
            <div class="${isModern ? 'tutorial-modern-content-inner' : ''}" style="${isModern ? '' : 'padding-top: 15px;'}">
                ${notesHtml}
            </div>
        </div>
    `;
    
    tutorialContent.appendChild(updateSection);
}

function showUpdateModal() {
    const modal = document.getElementById('update-log-modal');
    const contentEl = document.getElementById('update-log-modal-content');
    const closeBtn = document.getElementById('close-update-log-modal');

    const latestLog = updateLog[0];
    if (!latestLog) return;

    // 优化内容渲染
    let notesHtml = '<div style="text-align: left; max-height: 60vh; overflow-y: auto; padding-right: 5px;">';
    latestLog.notes.forEach(note => {
        // 处理加粗标记 **text** -> <b>text</b>
        let formattedNote = note.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

        if (note.includes('————')) {
            // 分割线
            notesHtml += '<hr style="margin: 15px 0; border: 0; border-top: 1px dashed #ccc;">';
        } else if (/^\d+\./.test(note)) {
            // 标题行 (例如 "1.日记功能升级！")
            notesHtml += `<h4 style="margin: 15px 0 8px; color: #333; font-size: 15px; font-weight: 600;">${formattedNote}</h4>`;
        } else {
            // 普通内容行
            notesHtml += `<div style="margin-bottom: 6px; color: #555; font-size: 13px; line-height: 1.5; padding-left: 12px; position: relative;">
                <span style="position: absolute; left: 0; top: 0; color: #999;">•</span>${formattedNote}
            </div>`;
        }
    });
    notesHtml += '</div>';

    contentEl.innerHTML = `
        <h3 style="margin-top: 0; margin-bottom: 15px; text-align: center;">版本 ${latestLog.version} (${latestLog.date})</h3>
        ${notesHtml}
        <p style="font-size: 12px; color: #888; text-align: center; margin-top: 15px; border-top: 1px solid #eee; padding-top: 10px;">过往更新说明可在“教程”应用内查看。</p>
    `;

    modal.classList.add('visible');

    // 强制阅读倒计时
    const originalText = "我知道了";
    let timeLeft = 10;
    closeBtn.disabled = true;
    closeBtn.textContent = `请阅读 (${timeLeft}s)`;
    closeBtn.style.opacity = '0.6';
    closeBtn.style.cursor = 'not-allowed';

    const timer = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            closeBtn.textContent = `请阅读 (${timeLeft}s)`;
        } else {
            clearInterval(timer);
            closeBtn.disabled = false;
            closeBtn.textContent = originalText;
            closeBtn.style.opacity = '1';
            closeBtn.style.cursor = 'pointer';
        }
    }, 1000);

    closeBtn.onclick = () => {
        modal.classList.remove('visible');
        localStorage.setItem('lastSeenVersion', appVersion);
    };
}

function checkForUpdates() {
    const lastSeenVersion = localStorage.getItem('lastSeenVersion');
    if (lastSeenVersion !== appVersion) {
        // 仅当当前版本为 1.8.0 时，才执行引导重置
        if (appVersion === '1.8.0') {
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith('guide_')) {
                    localStorage.removeItem(key);
                }
            });
        }

        setTimeout(showUpdateModal, 500);
    }
}

// --- Guide System (分步引导) ---
const GuideSystem = {
    check: function(guideId, nextCallback) {
        // 检查是否已显示过
        if (localStorage.getItem(guideId) === 'true') return;

        // 根据 ID 定义引导内容
        let config = null;
        switch (guideId) {
            case 'guide_search_entry':
                config = {
                    target: '.search-bar-decoration',
                    text: '新增搜索功能！支持按角色、群聊筛选，快速查找历史记录。',
                    position: 'bottom'
                };
                break;
            case 'guide_char_gallery':
                config = {
                    target: '#char-gallery-manage-btn',
                    text: '新增 TA 相册！在这里管理角色的专属照片，在聊天设置里开启此开关后，聊天时角色可直接发送上传的图片。',
                    position: 'top'
                };
                break;
            case 'guide_group_summary':
                config = {
                    target: '#memory-journal-btn',
                    text: '群聊记录太多？点击这里一键生成智能总结，自动关联当前群聊世界书，内置提示词。',
                    position: 'top'
                };
                break;
            case 'guide_group_notice':
                config = {
                    target: '#setting-group-notice',
                    text: '新增群公告！设置剧情背景或重要通知，让所有成员知晓。',
                    position: 'bottom',
                    parent: '.kkt-item' // 高亮父容器
                };
                break;
            case 'guide_group_gossip':
                config = {
                    target: '#setting-group-allow-gossip',
                    text: '开启群内私聊！双击群聊标题可查看，群成员之间可以悄悄互动，八卦吐槽更真实。',
                    position: 'bottom',
                    parent: '.kkt-item'
                };
                break;
            case 'guide_token_distribution':
                config = {
                    target: '#chat-expansion-panel',
                    text: '💡 提示：您现在可以从输入框上方的按钮，手动给单个人设分配指定的 Token。可以针对多人物合卡，单独给部分人设分配更多 Token 资源！',
                    position: 'top'
                };
                break;
        }

        if (config) {
            // 稍微延迟以确保 DOM 渲染完成
            setTimeout(() => {
                const targetEl = document.querySelector(config.target);
                if (targetEl && targetEl.offsetParent !== null) { // 确保元素可见
                    this.show(targetEl, config, guideId, nextCallback);
                }
            }, 500);
        }
    },

    show: function(targetEl, config, guideId, nextCallback) {
        // 1. 先滚动到可见区域
        const highlightEl = config.parent ? targetEl.closest(config.parent) : targetEl;
        
        // 特殊处理 Swiper 容器内的元素，避免触发页面整体水平滚动
        const swiperWrapper = highlightEl.closest('.function-swiper-wrapper');
        if (swiperWrapper) {
            const slide = highlightEl.closest('.function-slide');
            if (slide) {
                // 滚动到对应的 slide，使用 inline: 'start' 确保对齐且不溢出
                slide.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
            } else {
                highlightEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
            }
        } else {
            highlightEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // 强制重置页面水平滚动，防止露出侧边栏
        const resetScroll = () => {
            document.documentElement.scrollLeft = 0;
            document.body.scrollLeft = 0;
        };
        // 在滚动开始和结束时多次尝试重置
        setTimeout(resetScroll, 50);
        setTimeout(resetScroll, 200);
        setTimeout(resetScroll, 600);

        // 2. 延迟显示引导（等待滚动完成）
        setTimeout(() => {
            // 再次重置滚动位置，确保万无一失
            resetScroll();

            // 移除现有的引导
            this.cleanup();

            // 创建遮罩
            const overlay = document.createElement('div');
            overlay.className = 'guide-overlay visible';
            document.body.appendChild(overlay);

            // 重新计算高亮位置（滚动后）
            const rect = highlightEl.getBoundingClientRect();
            
            // 创建高亮框
            const highlightBox = document.createElement('div');
            highlightBox.className = 'guide-highlight-box';
            // 强制使用 fixed 定位，避免滚动容器导致的坐标偏移问题
            highlightBox.style.position = 'fixed';
            highlightBox.style.top = `${rect.top}px`;
            highlightBox.style.left = `${rect.left}px`;
            highlightBox.style.width = `${rect.width}px`;
            highlightBox.style.height = `${rect.height}px`;
            document.body.appendChild(highlightBox);

            // 创建提示气泡
            const tooltip = document.createElement('div');
            tooltip.className = `guide-tooltip ${config.position || 'bottom'} visible`;
            // 气泡也使用 fixed 定位
            tooltip.style.position = 'fixed';
            
            tooltip.innerHTML = `
                <div class="guide-content">${config.text}</div>
                <div class="guide-footer">
                    <button class="guide-btn guide-btn-primary">我知道了</button>
                </div>
            `;
            document.body.appendChild(tooltip);

            // 计算气泡位置 (需要先添加到 DOM 获取尺寸)
            const tooltipRect = tooltip.getBoundingClientRect();
            const tooltipWidth = tooltipRect.width;
            const screenWidth = window.innerWidth;
            const margin = 10; // 屏幕边缘间距

            let tooltipTop, tooltipLeft;
            
            // 初始水平居中对齐目标
            let idealLeft = rect.left + rect.width / 2 - tooltipWidth / 2;

            // 边界检测与调整
            if (idealLeft < margin) {
                tooltipLeft = margin;
            } else if (idealLeft + tooltipWidth > screenWidth - margin) {
                tooltipLeft = screenWidth - tooltipWidth - margin;
            } else {
                tooltipLeft = idealLeft;
            }

            // 计算箭头偏移量 (相对于 tooltip 左边缘)
            const targetCenterX = rect.left + rect.width / 2;
            let arrowRelX = targetCenterX - tooltipLeft;
            
            // 限制箭头在 tooltip 内部 (留出圆角空间)
            const arrowMargin = 20;
            if (arrowRelX < arrowMargin) arrowRelX = arrowMargin;
            if (arrowRelX > tooltipWidth - arrowMargin) arrowRelX = tooltipWidth - arrowMargin;

            // 设置箭头位置变量
            tooltip.style.setProperty('--arrow-left', `${arrowRelX}px`);

            // 垂直位置
            if (config.position === 'top') {
                tooltipTop = rect.top - 10; 
                tooltip.style.transform = 'translateY(-100%) translateY(-10px)';
            } else {
                tooltipTop = rect.bottom + 10;
                tooltip.style.transform = 'translateY(10px)';
            }
            
            tooltip.style.top = `${tooltipTop}px`;
            tooltip.style.left = `${tooltipLeft}px`;

            // 绑定事件
            const closeGuide = () => {
                this.cleanup();
                localStorage.setItem(guideId, 'true');
                if (nextCallback) nextCallback();
            };

            overlay.addEventListener('click', closeGuide);
            tooltip.querySelector('.guide-btn-primary').addEventListener('click', closeGuide);
        }, 500); // 等待 500ms 确保滚动完成
    },

    cleanup: function() {
        const overlay = document.querySelector('.guide-overlay');
        const highlight = document.querySelector('.guide-highlight-box');
        const tooltip = document.querySelector('.guide-tooltip');
        if (overlay) overlay.remove();
        if (highlight) highlight.remove();
        if (tooltip) tooltip.remove();
    }
};
window.GuideSystem = GuideSystem;

let loadingBtn = false

function customConfirm(message, title = '确认') {
    return new Promise((resolve) => {
        const modalId = 'custom-confirm-modal';
        let modal = document.getElementById(modalId);
        if (!modal) {
            modal = document.createElement('div');
            modal.id = modalId;
            modal.className = 'modal-overlay';
            modal.style.alignItems = 'center';
            modal.style.justifyContent = 'center';
            modal.style.zIndex = '100000';
            modal.innerHTML = `
                <div class="modal-window custom-confirm-window" style="max-width: 320px; width: 90%; padding: 20px;">
                    <h3 id="custom-confirm-title" style="margin-top:0; margin-bottom: 12px; font-size: 1.1rem; color: #333; text-align: center;"></h3>
                    <p id="custom-confirm-message" style="font-size: 0.95rem; color: #555; margin-bottom: 20px; line-height: 1.5; text-align: center; white-space: pre-wrap; max-height: 50vh; overflow-y: auto; text-align: left;"></p>
                    <div style="display: flex; gap: 10px;">
                        <button type="button" id="custom-confirm-ok-btn" class="btn btn-primary" style="flex:1; background: var(--primary-color, #ff6b81); border: none;">确定</button>
                        <button type="button" id="custom-confirm-cancel-btn" class="btn btn-neutral" style="flex:1;">取消</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        
        document.getElementById('custom-confirm-title').textContent = title;
        document.getElementById('custom-confirm-message').textContent = message;
        modal.style.display = 'flex';
        
        const okBtn = document.getElementById('custom-confirm-ok-btn');
        const cancelBtn = document.getElementById('custom-confirm-cancel-btn');
        
        const cleanup = () => {
            modal.style.display = 'none';
            okBtn.onclick = null;
            cancelBtn.onclick = null;
        };
        
        okBtn.onclick = () => { cleanup(); resolve(true); };
        cancelBtn.onclick = () => { cleanup(); resolve(false); };
    });
}

function customPrompt(message, defaultValue = '', title = '输入') {
    return new Promise((resolve) => {
        const modalId = 'custom-prompt-modal';
        let modal = document.getElementById(modalId);
        if (!modal) {
            modal = document.createElement('div');
            modal.id = modalId;
            modal.className = 'modal-overlay';
            modal.style.alignItems = 'center';
            modal.style.justifyContent = 'center';
            modal.style.zIndex = '100000';
            modal.innerHTML = `
                <div class="modal-window custom-prompt-window" style="max-width: 320px; width: 90%; padding: 20px;">
                    <h3 id="custom-prompt-title" style="margin-top:0; margin-bottom: 12px; font-size: 1.1rem; color: #333; text-align: center;"></h3>
                    <p id="custom-prompt-message" style="font-size: 0.95rem; color: #555; margin-bottom: 10px; line-height: 1.5; text-align: left;"></p>
                    <input type="text" id="custom-prompt-input" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 20px; box-sizing: border-box; font-size: 1rem; outline: none;">
                    <div style="display: flex; gap: 10px;">
                        <button type="button" id="custom-prompt-ok-btn" class="btn btn-primary" style="flex:1; background: var(--primary-color, #ff6b81); border: none;">确定</button>
                        <button type="button" id="custom-prompt-cancel-btn" class="btn btn-neutral" style="flex:1;">取消</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        
        document.getElementById('custom-prompt-title').textContent = title;
        document.getElementById('custom-prompt-message').textContent = message;
        const inputEl = document.getElementById('custom-prompt-input');
        inputEl.value = defaultValue;
        modal.style.display = 'flex';
        inputEl.focus();
        
        const okBtn = document.getElementById('custom-prompt-ok-btn');
        const cancelBtn = document.getElementById('custom-prompt-cancel-btn');
        
        const cleanup = () => {
            modal.style.display = 'none';
            okBtn.onclick = null;
            cancelBtn.onclick = null;
        };
        
        okBtn.onclick = () => { cleanup(); resolve(inputEl.value); };
        cancelBtn.onclick = () => { cleanup(); resolve(null); };
    });
}

function customAlert(message, title = '提示') {
    return new Promise((resolve) => {
        const modalId = 'custom-alert-modal';
        let modal = document.getElementById(modalId);
        if (!modal) {
            modal = document.createElement('div');
            modal.id = modalId;
            modal.className = 'modal-overlay';
            modal.style.alignItems = 'center';
            modal.style.justifyContent = 'center';
            modal.style.zIndex = '100000';
            modal.innerHTML = `
                <div class="modal-window custom-alert-window" style="max-width: 320px; width: 90%; padding: 20px;">
                    <h3 id="custom-alert-title" style="margin-top:0; margin-bottom: 12px; font-size: 1.1rem; color: #333; text-align: center;"></h3>
                    <p id="custom-alert-message" style="font-size: 0.95rem; color: #555; margin-bottom: 20px; line-height: 1.5; text-align: center; white-space: pre-wrap; max-height: 50vh; overflow-y: auto; text-align: left;"></p>
                    <div style="display: flex; justify-content: center;">
                        <button type="button" id="custom-alert-ok-btn" class="btn btn-primary" style="min-width: 120px; background: var(--primary-color, #ff6b81); border: none;">我知道了</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        
        document.getElementById('custom-alert-title').textContent = title;
        document.getElementById('custom-alert-message').textContent = message;
        modal.style.display = 'flex';
        
        const okBtn = document.getElementById('custom-alert-ok-btn');
        
        const cleanup = () => {
            modal.style.display = 'none';
            okBtn.onclick = null;
        };
        
        okBtn.onclick = () => { cleanup(); resolve(); };
    });
}

