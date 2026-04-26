// WebSocket连接
let ws = null;
/** 是否在 onclose 后等待重连；重连成功时需刷新设备/端点列表（后端重启后 endpoint id 会变） */
let wsReconnectPending = false;

// 同步操作状态（与复选框 sync-operation-cb 同步）
let syncOperationEnabled = false;
// 当前活跃设备（最后点击的设备，用于键盘输入到屏幕）
let currentActiveDeviceUDID = null;

// 当前活跃 Shell 窗口（最后点击的 Shell，用于键盘输入到该终端）
let currentActiveShellWindow = null;

// 设备选择变更回调列表
const deviceSelectionChangeCallbacks = [];

// 注册设备选择变更回调
function onDeviceSelectionChange(callback) {
    if (typeof callback === 'function') {
        deviceSelectionChangeCallbacks.push(callback);
    }
}

// 触发设备选择变更回调
function triggerDeviceSelectionChange() {
    deviceSelectionChangeCallbacks.forEach(callback => {
        try {
            callback();
        } catch (error) {
            console.error('设备选择变更回调执行失败:', error);
        }
    });
}

// 端点输入格式说明（placeholder 与空值提示共用，与后端 adb=,name=,proxy=,retry= 约定一致）
const ENDPOINT_FORMAT_HINT = 'adb=127.0.0.1:5037,name=本机';

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    initWebSocket();
    loadDevices();
    setupRefreshButton();
    ensureBarSelectAll(); // 从 tpl-section-select-all 克隆 bar 的「选中」，再绑定
    setupSelectAllCheckbox();
    setupBatchOperationsDropdown();
    setupSyncOperationButton();
    setupGlobalKeyboardInput();
    initFullscreenMode();
    initShellPanel();
    initEndpointsPanel();
});

// 页面关闭时清理所有WebRTC连接
window.addEventListener('beforeunload', () => {
    console.log('页面即将关闭，清理所有WebRTC连接...');
    // 清理所有活跃的WebRTC连接
    activeWebRTCConnections.forEach((conn, deviceUDID) => {
        console.log(`清理设备 ${deviceUDID} 的WebRTC连接...`);
        cleanupWebRTCConnection(deviceUDID);
    });
});

// 页面隐藏时也清理（移动端可能不会触发beforeunload）
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        console.log('页面已隐藏，清理所有WebRTC连接...');
        // 注意：这里不清理，因为用户可能只是切换标签页
        // 只在真正关闭时才清理
    }
});

// 投屏颜色校正：部分设备编码器输出红蓝通道互换，用 WebGL 在浏览器端交换 R/B 显示。URL 加 ?video_rb_swap=1 启用
function shouldEnableVideoColorCorrectRB() {
    return new URLSearchParams(window.location.search).get('video_rb_swap') === '1';
}
function createVideoColorCorrectRB(video, wrapper) {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    canvas.style.pointerEvents = 'none';
    video.style.position = 'absolute';
    video.style.left = '0';
    video.style.top = '0';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    wrapper.style.position = 'relative';
    wrapper.appendChild(canvas);
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return null;
    const vshader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vshader, 'attribute vec2 a_pos;varying vec2 v_uv;void main(){v_uv=a_pos*0.5+0.5;gl_Position=vec4(a_pos,0.0,1.0);}');
    gl.compileShader(vshader);
    const fshader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fshader, 'precision mediump float;uniform sampler2D u_tex;varying vec2 v_uv;void main(){vec4 c=texture2D(u_tex,v_uv);gl_FragColor=vec4(c.b,c.g,c.r,c.a);}');
    gl.compileShader(fshader);
    const program = gl.createProgram();
    gl.attachShader(program, vshader);
    gl.attachShader(program, fshader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    let rafId = 0;
    function draw() {
        rafId = requestAnimationFrame(draw);
        const w = video.videoWidth || 1;
        const h = video.videoHeight || 1;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (w > 1 && h > 1 && video.readyState >= 2) {
            const tex = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            gl.useProgram(program);
            gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            const a_pos = gl.getAttribLocation(program, 'a_pos');
            gl.enableVertexAttribArray(a_pos);
            gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.deleteTexture(tex);
        }
    }
    draw();
    return function stop() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
    };
}


// 初始化WebSocket
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket连接已建立');
        if (wsReconnectPending) {
            wsReconnectPending = false;
            loadDevices();
            showNotification('已重连后端，已刷新设备与端点列表', null, 2500, 'success');
        }
    };
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket错误:', error);
    };
    
    ws.onclose = (event) => {
        console.log('WebSocket连接已关闭，5秒后重连...');
        wsReconnectPending = true;

        // 检查是否有活跃的WebRTC连接或设备
        const deviceCards = document.querySelectorAll('.device-video-card');
        const hasActiveConnections = activeWebRTCConnections.size > 0;
        const hasDevices = deviceCards.length > 0;
        
        if (hasActiveConnections || hasDevices) {
            console.log(`检测到后端断开，清理 ${activeWebRTCConnections.size} 个活跃连接，更新 ${deviceCards.length} 个设备状态...`);
            
            // 显示全局提示
            showNotification('后端服务已断开，正在清理连接...', null, 3000, 'error');
            
            // 复用设备拔除逻辑：将所有设备状态设置为 offline
            // 这会自动触发状态灯更新、连接清理和UI恢复
            deviceCards.forEach(card => {
                const deviceUDID = card.dataset.udid;
                if (deviceUDID) {
                    // 获取设备信息
                    const deviceName = card.dataset.deviceName || deviceUDID;
                    const platform = card.dataset.platform || 'android';
                    const model = card.dataset.model || '未知型号';
                    
                    // 调用 updateDeviceStatus，复用设备拔除的处理逻辑
                    // 这会自动更新状态灯、清理连接、恢复UI
                    updateDeviceStatus(deviceUDID, {
                        udid: deviceUDID,
                        name: deviceName,
                        status: 'offline',
                        platform: platform,
                        model: model
                    });
                    
                    // 为每个设备显示断开提示
                    if (hasActiveConnections && activeWebRTCConnections.has(deviceUDID)) {
                        showNotification('连接已断开', deviceUDID, 2000, 'error');
                    }
                }
            });
        }
        
        setTimeout(initWebSocket, 5000);
    };
}

// 处理WebSocket消息
function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'device_status':
            const oldStatus = getDeviceStatus(message.device_udid);
            updateDeviceStatus(message.device_udid, message.data);
            const newStatus = message.data?.status;
            
            // 如果设备状态发生变化（online <-> offline），触发设备变更回调（传 data 以便用完整 apiUdid 调 API）
            if (oldStatus !== newStatus && (oldStatus === 'offline' || newStatus === 'offline' || oldStatus === 'online' || newStatus === 'online')) {
                triggerDeviceStatusChange(message.device_udid, oldStatus, newStatus, message.data);
            }
            break;
        case 'endpoint_status':
            // 单个端点连接状态：ok | reconnecting | reconnect_failed | removed
            if (message.data && message.data.endpoint) {
                const statusEl = document.querySelector(`.endpoint-connection-status[data-endpoint="${escapeHtml(message.data.endpoint)}"]`);
                if (statusEl) {
                    const s = (message.data.status || '').toLowerCase();
                    const statusTextMap = { ok: '', reconnecting: '🟡 重连中', reconnect_failed: '🔴 重连失败', removed: '🔴 已移除' };
                    const text = (statusTextMap[s] !== undefined) ? statusTextMap[s] : (message.data.status || '');
                    statusEl.textContent = text;
                    statusEl.className = 'endpoint-connection-status endpoint-status-' + (s || 'ok');
                }
            }
            break;
        case 'endpoints_changed':
            // 端点增删（含 auto-robot 等外部修改），刷新端点与设备列表
            loadDevices();
            if (typeof loadEndpoints === 'function') loadEndpoints();
            showNotification('端点列表已更新', null, 2000, 'info');
            break;
    }
}

// 按 udid 查找卡片：支持 serial 时用 findWrappersBySerial 取 card，支持精确 apiUdid/deviceId 时匹配 data-device-id 或 data-udid
function findCardsByUdid(udid) {
    if (!udid) return [];
    const isSerial = udid.indexOf('@') === -1 && udid.indexOf(':') === -1;
    if (isSerial) {
        const wrappers = findWrappersBySerial(udid);
        return wrappers.map(w => w.querySelector('.device-video-card')).filter(Boolean);
    }
    const wrappers = document.querySelectorAll('.device-card-wrapper[data-device-id]');
    const out = [];
    wrappers.forEach(w => {
        if ((w.dataset.deviceId || w.dataset.udid) === udid) out.push(w.querySelector('.device-video-card'));
    });
    return out.filter(Boolean);
}

// 获取设备状态（serial 或 deviceId）
function getDeviceStatus(udid) {
    const cards = findCardsByUdid(udid);
    if (cards.length > 0) return (cards[0].dataset && cards[0].dataset.status) || 'unknown';
    return 'unknown';
}

// 设备状态变更回调列表
const deviceStatusChangeCallbacks = [];

// 注册设备状态变更回调
function onDeviceStatusChange(callback) {
    if (typeof callback === 'function') {
        deviceStatusChangeCallbacks.push(callback);
    }
}

// 触发设备状态变更回调。deviceData 为 WebSocket 推送的完整设备对象，用于拼 apiUdid（如 serial:transport_id@endpoint_id）
function triggerDeviceStatusChange(udid, oldStatus, newStatus, deviceData) {
    deviceStatusChangeCallbacks.forEach(callback => {
        try {
            callback(udid, oldStatus, newStatus, deviceData);
        } catch (error) {
            console.error('设备状态变更回调执行失败:', error);
        }
    });
}

// 返回用于 API 请求的 udid（含 transport_id / endpoint_id）
function getDeviceApiUdid(device) {
    const serial = device.udid || '';
    const tid = device.transport_id != null && device.transport_id > 0 ? device.transport_id : 0;
    const eid = device.endpoint_id || '';
    return serial + (tid ? ':' + tid : '') + (eid ? '@' + eid : '');
}

// 设备 id：拔插后不变，指代设备（槽位），用于卡片唯一标识与注册表 key（serial 或 serial@endpointId）
function getDeviceId(device) {
    const serial = (device && device.udid) || '';
    const eid = (device && device.endpoint_id) || '';
    return serial + (eid ? '@' + eid : '');
}

// 设备注册表：deviceId -> { apiUdid }，唯一数据源；拔插后只更新 apiUdid，不依赖 DOM
const deviceRegistry = new Map();

// 从卡片 wrapper 取当前用于 API 的 udid（从注册表读，无则回退 deviceId）
function getApiUdidForCard(wrapper) {
    if (!wrapper) return '';
    const deviceId = wrapper.dataset.deviceId || wrapper.dataset.udid;
    const entry = deviceId ? deviceRegistry.get(deviceId) : null;
    return (entry && entry.apiUdid) || deviceId || '';
}

// 是否在全屏 UI 内（底部栏或顶栏），避免重复写 focus-controls/focus-header 判断
function isElementInFullscreenUI(el) {
    return el && (el.closest('#focus-controls') || el.closest('.focus-header'));
}

// 从按钮上下文取 apiUdid（卡片内用 wrapper，全屏内用 currentFullscreenDeviceUDID）——便于同一套按钮在卡片/全屏复用
function getApiUdidFromButton(btn) {
    if (!btn) return '';
    const w = btn.closest('.device-card-wrapper');
    if (w) return getApiUdidForCard(w);
    if (isElementInFullscreenUI(btn)) return currentFullscreenDeviceUDID || '';
    return '';
}

// 按 serial 查找 wrapper（WebSocket 只发 serial；匹配 deviceId === serial 或 deviceId.startsWith(serial+'@')）
function findWrappersBySerial(serial) {
    if (!serial) return [];
    const wrappers = document.querySelectorAll('.device-card-wrapper[data-device-id]');
    const out = [];
    wrappers.forEach(w => {
        const did = w.dataset.deviceId || '';
        if (did === serial || did.startsWith(serial + '@')) out.push(w);
    });
    return out;
}

// 按当前 apiUdid 查找 wrapper（从注册表反查）。仅用于卡片内元素（.device-video-card、.device-video-container 等）。
// 侧栏/底栏内的按钮等请用 getControlPanelsForDevice(deviceUDID)，否则全屏下面板移出 wrapper 后会查不到。
function findWrapperByApiUdid(apiUdid) {
    if (!apiUdid) return null;
    const wrappers = document.querySelectorAll('.device-card-wrapper[data-device-id]');
    for (const w of wrappers) {
        if (getApiUdidForCard(w) === apiUdid) return w;
    }
    return null;
}

// 按 deviceId 查找 wrapper（前端统一用 deviceId，DOM 以 deviceId 为 key）
function findWrapperByDeviceId(deviceId) {
    if (!deviceId) return null;
    return document.querySelector(`.device-card-wrapper[data-device-id="${CSS.escape(deviceId)}"]`);
}

// 用于 DOM id 的安全形式（避免 : @ 在 CSS 选择器中歧义）
function safeIdFromUdid(udid) {
    return (udid || '').replace(/[:@]/g, '_');
}

// 从 deviceId 取 apiUdid（仅在与后端/API 交互时使用）
function getApiUdid(deviceId) {
    const entry = deviceRegistry.get(deviceId);
    return (entry && entry.apiUdid) || deviceId || '';
}

// 从 apiUdid 解析出 deviceId（仅用于从后端/WebSocket 拿到 apiUdid 时）
function getDeviceIdForApiUdid(apiUdid) {
    const wrapper = findWrapperByApiUdid(apiUdid);
    return wrapper ? (wrapper.dataset.deviceId || apiUdid) : apiUdid;
}

// 设备列表展示模式：'sections' 按端点分栏，'single-grid' 单一大 grid
let devicesListViewMode = 'sections';
function getDevicesListViewMode() { return devicesListViewMode; }
function setDevicesListViewMode(mode) { devicesListViewMode = mode; }

// 向一个 grid 元素填充设备卡片；按 deviceId 匹配与去重（设备 id 稳定，API udid 在注册表）
function fillDeviceGrid(grid, devices, currentDeviceUDIDs, existingItems) {
    if (!grid) return;
    devices.forEach(device => {
        const deviceId = getDeviceId(device);
        const apiUdid = getDeviceApiUdid(device);
        currentDeviceUDIDs.add(deviceId);
        let gridItem = grid.querySelector(`.device-grid-item:has(.device-card-wrapper[data-device-id="${CSS.escape(deviceId)}"])`);
        if (!gridItem && existingItems && existingItems.has(deviceId)) {
            gridItem = existingItems.get(deviceId);
            existingItems.delete(deviceId);
            grid.appendChild(gridItem);
        }
        let wrapper = gridItem ? gridItem.querySelector('.device-card-wrapper') : null;
        if (!gridItem) {
            wrapper = createDeviceCard(device);
            gridItem = document.createElement('div');
            gridItem.className = 'device-grid-item';
            gridItem.appendChild(wrapper);
            grid.appendChild(gridItem);
            deviceConnectionStates.set(apiUdid, DeviceConnectionState.DISCONNECTED);
        } else {
            deviceRegistry.set(deviceId, { apiUdid });
            wrapper.dataset.udid = apiUdid;
            updateDeviceCardStatus(wrapper, device);
        }
    });
    grid.querySelectorAll('.device-grid-item').forEach(item => {
        const w = item.querySelector('.device-card-wrapper');
        const deviceId = w && (w.dataset.deviceId || w.dataset.udid);
        if (w && deviceId && !currentDeviceUDIDs.has(deviceId)) {
            const apiUdid = getApiUdidForCard(w);
            if (apiUdid && activeWebRTCConnections.get(apiUdid)) cleanupWebRTCConnection(apiUdid);
            deviceConnectionStates.delete(apiUdid);
            deviceRegistry.delete(deviceId);
            item.remove();
        }
    });
}

// 确保容器只保留当前 viewMode 对应的根结构，返回用于填充的「当前根」；切换模式时先清空再建
function ensureDevicesListRoot(container, viewMode) {
    const hasWrap = container.querySelector('.devices-single-grid-wrap');
    const hasSections = container.querySelectorAll('.devices-section').length > 0;
    if (viewMode === 'single-grid') {
        if (hasWrap) return container.querySelector('.devices-single-grid-wrap');
        container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'devices-single-grid-wrap';
        wrap.innerHTML = '<div class="devices-grid"></div>';
        container.appendChild(wrap);
        return wrap;
    }
    // sections
    if (hasWrap) container.innerHTML = '';
    return null;
}

// 创建单个 section 的 DOM 并绑定事件（「选中本栏」由 ensureSectionSelectAll 统一插入，避免重复）
function createDevicesSection(epKey, endpointValue, sectionTitle) {
    const section = document.createElement('div');
    section.className = 'devices-section';
    section.dataset.endpoint = epKey;
    section.dataset.endpointValue = endpointValue;
    section.innerHTML = `
        <div class="devices-section-title">
            <span class="device-status-display device-status-display-section" data-endpoint="${escapeHtml(epKey)}"></span>
            <span class="endpoint-connection-status" data-endpoint="${escapeHtml(epKey)}" title="端点连接状态"></span>
            <span class="devices-section-arrow" aria-expanded="true">▼</span>
            <span class="devices-section-title-text">${escapeHtml(sectionTitle)}</span>
            <button type="button" class="endpoint-info-btn" title="查看端点详情" aria-label="查看端点详情">ℹ️</button>
            <button type="button" class="devices-section-disconnect" title="断开连接">⛓️‍💥</button>
        </div>
        <div class="devices-section-list devices-grid"></div>
    `;
    const titleEl = section.querySelector('.devices-section-title');
    const arrowEl = section.querySelector('.devices-section-arrow');
    const disconnectBtn = section.querySelector('.devices-section-disconnect');
    const sectionInfoBtn = section.querySelector('.devices-section-title .endpoint-info-btn');
    if (sectionInfoBtn) {
        sectionInfoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showEndpointDetailModal(epKey);
        });
    }
    titleEl.addEventListener('click', (e) => {
        if (e.target === disconnectBtn || e.target.closest('.section-select-all') || e.target.closest('.devices-section-refresh') || e.target.closest('.endpoint-info-btn')) return;
        section.classList.toggle('devices-section-collapsed');
        const collapsed = section.classList.contains('devices-section-collapsed');
        if (arrowEl) {
            arrowEl.textContent = collapsed ? '▶' : '▼';
            arrowEl.setAttribute('aria-expanded', !collapsed);
        }
    });
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!confirm(`确定要断开端点「${sectionTitle}」吗？`)) return;
            deleteEndpoint(section.dataset.endpointValue || epKey);
        });
    }
    ensureSectionSelectAll(section);
    return section;
}

// 从 HTML template 克隆「选中」控件（bar 与 section 共用，结构只定义在 index.html 的 tpl-section-select-all）
function cloneSectionSelectAllLabel(opts) {
    const tpl = document.getElementById('tpl-section-select-all');
    if (!tpl || !tpl.content) return null;
    const label = tpl.content.cloneNode(true).querySelector('label');
    if (!label) return null;
    if (opts.idWrap) label.id = opts.idWrap;
    if (opts.checkboxId) {
        const input = label.querySelector('.section-select-all-checkbox');
        if (input) input.id = opts.checkboxId;
        if (opts.idWrap) label.setAttribute('for', opts.checkboxId);
    }
    if (opts.title != null) label.title = opts.title;
    return label;
}

function ensureBarSelectAll() {
    const bar = document.querySelector('.devices-container-bar');
    if (!bar || document.getElementById('select-all-devices')) return;
    // 先在 toggle 按钮后面添加占位元素
    if (!bar.querySelector('.devices-bar-spacer')) {
        const spacer = document.createElement('div');
        spacer.className = 'devices-bar-spacer';
        const toggleBtn = document.getElementById('devices-toggle-sections-btn');
        if (toggleBtn && toggleBtn.parentNode) {
            toggleBtn.parentNode.insertBefore(spacer, toggleBtn.nextSibling);
        }
    }
    // 然后插入 select-all-wrap（在 spacer 后面）
    const label = cloneSectionSelectAllLabel({
        idWrap: 'select-all-wrap',
        checkboxId: 'select-all-devices',
        title: '选中全部'
    });
    if (label) {
        const spacer = bar.querySelector('.devices-bar-spacer');
        if (spacer && spacer.parentNode) {
            // spacer 存在时，插入在 spacer 后面
            spacer.parentNode.insertBefore(label, spacer.nextSibling);
        } else {
            // 兜底：spacer 不存在时，插入在 toggle 的 nextSibling 之前
            const next = document.getElementById('devices-toggle-sections-btn')?.nextElementSibling;
            bar.insertBefore(label, next || null);
        }
    }
    // 在 select-all-wrap 右边、devices-connect-btn 左边插入刷新按钮
    if (!document.getElementById('devices-bar-refresh-btn')) {
        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.id = 'devices-bar-refresh-btn';
        refreshBtn.className = 'devices-bar-btn';
        refreshBtn.title = '刷新设备列表并清理离线设备';
        refreshBtn.textContent = '🔄';
        const connectBtn = document.getElementById('devices-connect-btn');
        // 直接插入在 connectBtn 之前（select-all-wrap 已插入在 spacer 之后、connectBtn 之前）
        if (connectBtn && connectBtn.parentNode) {
            connectBtn.parentNode.insertBefore(refreshBtn, connectBtn);
        }
        refreshBtn.addEventListener('click', () => handleRefreshDevices(refreshBtn));
    }
}

// 为 section 插入「选中本栏」并绑定（新建与复用 section 共用，结构来自 tpl-section-select-all）
function ensureSectionSelectAll(section) {
    if (section.querySelector('.section-select-all-checkbox')) return;
    const grid = section.querySelector('.devices-section-list');
    const insertBeforeEl = section.querySelector('.devices-section-disconnect');
    if (!insertBeforeEl || !insertBeforeEl.parentNode) return;
    const label = cloneSectionSelectAllLabel({ title: '选中本栏' });
    if (!label) return;
    const cb = label.querySelector('.section-select-all-checkbox');
    insertBeforeEl.parentNode.insertBefore(label, insertBeforeEl);
    // 在 section-select-all 之后、disconnect 之前插入刷新按钮
    if (!section.querySelector('.devices-section-refresh')) {
        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'devices-section-refresh';
        refreshBtn.title = '刷新设备列表';
        refreshBtn.textContent = '🔄';
        insertBeforeEl.parentNode.insertBefore(refreshBtn, insertBeforeEl);
        refreshBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleRefreshDevices(refreshBtn);
        });
    }
    if (cb && grid) {
        cb.addEventListener('change', (e) => {
            e.stopPropagation();
            const checked = e.target.checked;
            grid.querySelectorAll('.device-card-wrapper').forEach(w => {
                const card = w.querySelector('.device-video-card');
                if (checked) {
                    w.classList.add('selected');
                    if (card) card.classList.add('selected');
                } else {
                    w.classList.remove('selected');
                    if (card) card.classList.remove('selected');
                }
            });
            updateSelectAllCheckbox();
            triggerDeviceSelectionChange();
        });
        cb.addEventListener('click', (e) => e.stopPropagation());
    }
}

// 从 tpl-device-select-modal 克隆弹窗壳子，避免多处手写 device-select-content 结构
function createDeviceSelectModal(opts) {
    const tpl = document.getElementById('tpl-device-select-modal');
    if (!tpl || !tpl.content) return null;
    const wrap = tpl.content.cloneNode(true).querySelector('.device-select-content');
    if (!wrap) return null;
    if (opts.maxWidth) wrap.style.maxWidth = opts.maxWidth;
    const h3 = wrap.querySelector('.device-select-header h3');
    const body = wrap.querySelector('.device-select-body');
    const closeBtn = wrap.querySelector('.close-btn');
    if (h3 && opts.title != null) h3.textContent = opts.title;
    if (body && opts.bodyHTML != null) body.innerHTML = opts.bodyHTML;
    return { wrap, body, closeBtn };
}

// 未连接占位：结构只写一处，两处调用（createDeviceCard、恢复初始状态）
function getLoadingStateHTML(model, deviceUDID) {
    const m = model || '未知型号';
    return `<div class="loading-state"><p>📱 Android设备</p><p style="font-size: 12px; opacity: 0.7;">${escapeHtml(m)}</p><button class="start-stream-btn" data-udid="${escapeHtml(deviceUDID)}">🔗 连接</button></div>`;
}

// 错误状态块：统一结构，多处复用
function createErrorStateHTML(title, detail) {
    if (!detail) return `<div class="error-state"><p>${escapeHtml(title)}</p></div>`;
    return `<div class="error-state"><p>${escapeHtml(title)}</p><p style="font-size: 12px; margin-top: 10px;">${escapeHtml(detail)}</p></div>`;
}

// 设备名+状态图标：统一结构，避免多处重复
function renderDeviceNameWithStatusHTML(deviceName, statusIcon, compact) {
    const name = escapeHtml(deviceName);
    if (compact) return `<span style="margin-right: 8px;">${statusIcon}</span>${name}`;
    return `<span style="margin-right: 8px; flex-shrink: 0;">${statusIcon}</span><span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;">${name}</span>`;
}

// 封装：根据当前 viewMode 渲染设备列表（sections 或 single-grid），返回当前设备 UDID 集合；切换模式时复用已有卡片 DOM 不断连
function renderDevicesList(container, payload) {
    const { endpointOrder, endpointValueByDisplayName, endpointDisplayById, byEndpoint, orderedEndpointKeys, sortDevices } = payload;
    const currentDeviceUDIDs = new Set();
    const viewMode = getDevicesListViewMode();

    const existingItems = new Map();
    container.querySelectorAll('.device-grid-item').forEach(item => {
        const w = item.querySelector('.device-card-wrapper');
        const deviceId = w && (w.dataset.deviceId || w.dataset.udid);
        if (w && deviceId) {
            existingItems.set(deviceId, item);
            item.remove();
        }
    });

    const root = ensureDevicesListRoot(container, viewMode);

    if (viewMode === 'single-grid') {
        const grid = root.querySelector('.devices-grid');
        const allDevices = [];
        orderedEndpointKeys.forEach(epKey => {
            (byEndpoint[epKey] || []).sort(sortDevices).forEach(d => allDevices.push(d));
        });
        fillDeviceGrid(grid, allDevices, currentDeviceUDIDs, existingItems);
    } else {
        orderedEndpointKeys.forEach(epKey => {
            const devices = (byEndpoint[epKey] || []).sort(sortDevices);
            const sectionTitle = endpointValueByDisplayName[epKey] || endpointDisplayById[epKey] || epKey || '默认';
            const endpointValue = epKey;
            let section = null;
            container.querySelectorAll('.devices-section').forEach(s => {
                if (s.dataset.endpoint === epKey) section = s;
            });
            if (!section) {
                section = createDevicesSection(epKey, endpointValue, sectionTitle);
                container.appendChild(section);
            } else {
                section.dataset.endpointValue = endpointValue;
                const titleText = section.querySelector('.devices-section-title-text');
                if (titleText) titleText.textContent = sectionTitle;
                ensureSectionSelectAll(section);
            }
            const grid = section.querySelector('.devices-section-list');
            fillDeviceGrid(grid, devices, currentDeviceUDIDs, existingItems);
        });

        const orderedSet = new Set(orderedEndpointKeys);
        container.querySelectorAll('.devices-section').forEach(section => {
            const ep = section.dataset.endpoint;
            if (!orderedSet.has(ep)) {
                section.remove();
                return;
            }
            const grid = section.querySelector('.devices-section-list');
            const hasDevices = grid && grid.querySelectorAll('.device-card-wrapper').length > 0;
            const inOrder = endpointOrder.includes(ep);
            if (!hasDevices && !inOrder) section.remove();
        });
    }

    existingItems.forEach((item, deviceId) => {
        const w = item.querySelector('.device-card-wrapper');
        const apiUdid = getApiUdidForCard(w);
        if (apiUdid && activeWebRTCConnections.get(apiUdid)) cleanupWebRTCConnection(apiUdid);
    });
    return currentDeviceUDIDs;
}

// 加载设备列表
async function loadDevices(showLoading = false, refreshBtn = null) {
    const sectionsContainer = document.getElementById('devices-list-sections');
    if (!sectionsContainer) return;

    try {
        // refreshBtn 由调用方传入（bar 或 section 的刷新按钮），loading 状态已在 handleRefreshDevices 中处理

        const [devicesRes, endpointsRes] = await Promise.all([
            fetch('/api/devices'),
            fetch('/api/endpoints')
        ]);
        const data = await devicesRes.json();
        const epData = await endpointsRes.json().catch(() => ({}));
        const endpointsList = Array.isArray(epData?.endpoints) ? epData.endpoints : (Array.isArray(epData) ? epData : []);
        lastEndpointsList = endpointsList;
        const addEl = document.querySelector('.endpoints-add');
        const hintEl = document.querySelector('.endpoints-format-hint');
        const allowEdit = epData.endpointsMutable !== false;
        if (addEl) addEl.style.display = allowEdit ? '' : 'none';
        if (hintEl) hintEl.style.display = allowEdit ? '' : 'none';

        // 统一用 endpoint id 作为 key，display name 仅用于展示；避免 id 与 endpoint(显示名) 被当成两个端点
        const endpointOrder = [];
        const endpointDisplayNames = {};
        const endpointValueByDisplayName = {};
        if (Array.isArray(endpointsList)) {
            endpointsList.forEach(ep => {
                let id, displayName;
                if (typeof ep === 'string') {
                    id = displayName = ep;
                } else {
                    id = ep.id || (ep.host != null && ep.port != null ? `${ep.host}:${ep.port}` : '');
                    displayName = ep.endpoint || ep.id || id;
                }
                if (!id) return;
                endpointOrder.push(id);
                endpointDisplayNames[id] = true;
                endpointValueByDisplayName[id] = displayName;
            });
        }

        const byEndpoint = {};
        const endpointDisplayById = {};
        (data.devices || []).forEach(d => {
            const epKey = d.endpoint_id != null ? String(d.endpoint_id) : '';
            if (!byEndpoint[epKey]) byEndpoint[epKey] = [];
            byEndpoint[epKey].push(d);
            if (!endpointDisplayById[epKey] && d.endpoint) endpointDisplayById[epKey] = String(d.endpoint);
        });
        const orderedEndpointKeys = [...endpointOrder];
        Object.keys(byEndpoint).forEach(ep => {
            if (!endpointDisplayNames[ep]) orderedEndpointKeys.push(ep);
        });

        const sortDevices = (a, b) => {
            const nameA = (a.name || '').toLowerCase();
            const nameB = (b.name || '').toLowerCase();
            const c = nameA.localeCompare(nameB);
            if (c !== 0) return c;
            return (a.udid || '').toLowerCase().localeCompare((b.udid || '').toLowerCase());
        };

        const existingCardsBefore = sectionsContainer.querySelectorAll('.device-card-wrapper');
        const existingUDIDs = new Set(Array.from(existingCardsBefore).map(c => c.dataset.deviceId || c.dataset.udid).filter(Boolean));
        const payload = { endpointOrder, endpointValueByDisplayName, endpointDisplayById, byEndpoint, orderedEndpointKeys, sortDevices };
        const currentDeviceUDIDs = renderDevicesList(sectionsContainer, payload);
        document.querySelectorAll('.devices-section-disconnect').forEach(el => {
            el.style.display = allowEdit ? '' : 'none';
        });
        syncBarStatusDisplays(sectionsContainer, getDevicesListViewMode(), orderedEndpointKeys);
        updateDeviceStatusDisplay();

        let removedCount = 0;
        existingUDIDs.forEach(deviceId => {
            if (!currentDeviceUDIDs.has(deviceId)) {
                const apiUdid = deviceRegistry.get(deviceId)?.apiUdid;
                if (apiUdid && activeWebRTCConnections.get(apiUdid)) cleanupWebRTCConnection(apiUdid);
                removeDeviceCard(deviceId);
                removedCount++;
            }
        });

        if (showLoading && removedCount > 0) {
            showNotification(`已清理 ${removedCount} 个离线设备`, 'success');
        } else if (showLoading) {
            showNotification('设备列表已刷新', 'success');
        }
        updateSelectAllCheckbox();
    } catch (error) {
        console.error('加载设备列表失败:', error);
        if (showLoading) showNotification('刷新设备列表失败', 'error');
    }
}

// 重新排序设备卡片（不破坏现有连接；sections 时每个 section 内排序，single-grid 时整表排序）
function sortDeviceCards() {
    const sectionsContainer = document.getElementById('devices-list-sections');
    if (!sectionsContainer) return;
    const grids = sectionsContainer.querySelectorAll('.devices-grid');
    grids.forEach(devicesList => {
    const gridItems = Array.from(devicesList.querySelectorAll('.device-grid-item'));

    // 过滤出有设备数据的卡片和没有设备数据的卡片
    const itemsWithData = gridItems.filter(item => {
        const wrapper = item.querySelector('.device-card-wrapper');
        return wrapper && wrapper.deviceData;
    });
    const itemsWithoutData = gridItems.filter(item => {
        const wrapper = item.querySelector('.device-card-wrapper');
        return wrapper && !wrapper.deviceData;
    });

    // 按照设备名称和UDID排序有数据的卡片
    itemsWithData.sort((a, b) => {
        const wrapperA = a.querySelector('.device-card-wrapper');
        const wrapperB = b.querySelector('.device-card-wrapper');
        const deviceA = wrapperA.deviceData;
        const deviceB = wrapperB.deviceData;

        // 总是先按设备名称排序
        const nameA = (deviceA.name || '').toLowerCase();
        const nameB = (deviceB.name || '').toLowerCase();

        // 先按名称比较
        const nameCompare = nameA.localeCompare(nameB);
        if (nameCompare !== 0) {
            return nameCompare;
        }

        // 名称相同的情况下，按UDID比较
        const udidA = (deviceA.udid || '').toLowerCase();
        const udidB = (deviceB.udid || '').toLowerCase();
        return udidA.localeCompare(udidB);
    });

    // 重新排列DOM元素（保持现有的DOM结构和事件监听器）
    // 先移除所有元素
    gridItems.forEach(item => {
        devicesList.removeChild(item);
    });

    // 按正确顺序重新添加
    // 先添加有数据的卡片（已排序）
    itemsWithData.forEach(item => {
        devicesList.appendChild(item);
    });

    // 再添加没有数据的卡片（放在最后）
    itemsWithoutData.forEach(item => {
        devicesList.appendChild(item);
    });
    });
}

// 处理刷新设备（统一处理 bar 和 section 的刷新按钮）
function handleRefreshDevices(btn) {
    if (!btn) return;
    btn.disabled = true;
    btn.classList.add('loading');
    loadDevices(true, btn).then(() => {
        sortDeviceCards();
    }).catch(error => {
        console.error('刷新设备失败:', error);
    }).finally(() => {
        btn.disabled = false;
        btn.classList.remove('loading');
    });
}

// 设置刷新按钮（bar 的刷新按钮在 ensureBarSelectAll 中已设置）
function setupRefreshButton() {
    // bar 的刷新按钮已在 ensureBarSelectAll 中设置，section 的刷新按钮在 createDevicesSection 中设置
}

// 设置全选复选框
function setupSelectAllCheckbox() {
    const selectAllCheckbox = document.getElementById('select-all-devices');
    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            const deviceWrappers = document.querySelectorAll('.device-card-wrapper');
            deviceWrappers.forEach(wrapper => {
                const card = wrapper.querySelector('.device-video-card');
                if (isChecked) {
                    wrapper.classList.add('selected');
                    if (card) card.classList.add('selected');
                } else {
                    wrapper.classList.remove('selected');
                    if (card) card.classList.remove('selected');
                }
            });
            // 更新全选复选框状态和计数显示
            updateSelectAllCheckbox();
            // 触发设备选择变更回调
            triggerDeviceSelectionChange();
        });
    }
}

// 设置批量操作下拉菜单
function setupBatchOperationsDropdown() {
    const dropdownBtn = document.getElementById('batch-operations-btn');
    const menu = document.getElementById('batch-operations-menu');
    const connectBtn = document.getElementById('batch-connect-btn');
    const disconnectBtn = document.getElementById('batch-disconnect-btn');
    const dropdown = document.querySelector('.batch-operations-dropdown');
    
    if (dropdownBtn && menu && dropdown) {
        // 点击按钮切换菜单显示
        dropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('active');
            menu.classList.toggle('hidden');
        });
        
        // 点击外部关闭菜单
        document.addEventListener('click', (e) => {
            if (!dropdownBtn.contains(e.target) && !menu.contains(e.target)) {
                dropdown.classList.remove('active');
                menu.classList.add('hidden');
            }
        });
    }
    
    // 批量连接
    if (connectBtn) {
        connectBtn.addEventListener('click', async () => {
            const selectedDevices = getSelectedDevices();
            if (selectedDevices.length === 0) {
                showNotification('请先选中设备', null, 2000, 'warning');
                return;
            }
            if (dropdown) dropdown.classList.remove('active');
            if (menu) menu.classList.add('hidden');
            showNotification(`正在连接 ${selectedDevices.length} 个设备...`, null, 2000, 'info');

            // 同步启动所有设备的连接（selectedDevices 可能为 deviceId 或 apiUdid，先按 data-device-id 再按 data-udid 找卡片）
            const connectPromises = selectedDevices.map(deviceIdOrUdid => {
                return new Promise(resolve => {
                    let wrapper = findWrapperByDeviceId(deviceIdOrUdid);
                    if (!wrapper) {
                        wrapper = document.querySelector(`.device-card-wrapper[data-udid="${CSS.escape(deviceIdOrUdid)}"]`);
                    }
                    if (!wrapper) {
                        console.warn('[批量连接] 未找到对应卡片 (device-id/udid):', deviceIdOrUdid);
                        setTimeout(resolve, 100);
                        return;
                    }
                    const card = wrapper.querySelector('.device-video-card');
                    const videoWrapper = card && card.querySelector('.device-video-wrapper');
                    if (!videoWrapper) {
                        console.warn('[批量连接] 未找到视频容器:', deviceIdOrUdid);
                        setTimeout(resolve, 100);
                        return;
                    }
                    const apiUdid = getApiUdidForCard(wrapper) || getApiUdid(deviceIdOrUdid);
                    if (apiUdid) {
                        startDeviceStream(apiUdid, videoWrapper);
                    } else {
                        console.warn('[批量连接] 无法解析 apiUdid:', deviceIdOrUdid);
                    }
                    setTimeout(resolve, 100);
                });
            });

            // 等待所有连接启动完成
            await Promise.all(connectPromises);
        });
    }
    
    // 批量断开
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', () => {
            const selectedDevices = getSelectedDevices();
            if (selectedDevices.length === 0) {
                showNotification('请先选中设备', null, 2000, 'warning');
                return;
            }
            if (dropdown) dropdown.classList.remove('active');
            if (menu) menu.classList.add('hidden');
            
            // 全局确认一次
            if (confirm(`确定要断开 ${selectedDevices.length} 个设备的连接吗？`)) {
                showNotification(`正在断开 ${selectedDevices.length} 个设备...`, null, 2000, 'info');
                
                // 直接断开所有设备（selectedDevices 为 deviceId；调 API/操作连接用 apiUdid）
                selectedDevices.forEach(deviceId => {
                    const apiUdid = getApiUdid(deviceId);
                    const connectionState = getDeviceConnectionState(apiUdid);
                    if (connectionState === DeviceConnectionState.CONNECTING || connectionState === DeviceConnectionState.CONNECTED) {
                        fetch(`/api/device/${encodeURIComponent(apiUdid)}/webrtc/disconnect`, { method: 'POST' })
                            .catch(err => console.error(`通知后端断开设备 ${apiUdid} 连接失败:`, err));
                        setDeviceConnectionState(apiUdid, DeviceConnectionState.DISCONNECTED);
                        cleanupWebRTCConnection(apiUdid);
                    }
                });
            }
        });
    }
}

// 获取所有被选中的设备 deviceId（前端统一用 deviceId）
function getSelectedDevices() {
    const selectedDevices = [];
    const selectedWrappers = document.querySelectorAll('.device-card-wrapper.selected');
    selectedWrappers.forEach(wrapper => {
        const deviceId = wrapper.dataset.deviceId;
        if (deviceId) selectedDevices.push(deviceId);
    });
    return selectedDevices;
}

// 获取所有被选中的已连接设备 deviceId（有WebRTC连接且dataChannel打开；连接 Map 以 apiUdid 为 key）
function getSelectedConnectedDevices() {
    const selectedDevices = [];
    const selectedWrappers = document.querySelectorAll('.device-card-wrapper.selected');
    selectedWrappers.forEach(wrapper => {
        const deviceId = wrapper.dataset.deviceId;
        if (deviceId) {
            const apiUdid = getApiUdid(deviceId);
            const conn = apiUdid ? activeWebRTCConnections.get(apiUdid) : null;
            if (conn && conn.dataChannel && conn.dataChannel.readyState === 'open') {
                selectedDevices.push(deviceId);
            }
        }
    });
    return selectedDevices;
}

// 设置同步操作复选框
function setupSyncOperationButton() {
    const syncCb = document.getElementById('sync-operation-cb');
    if (syncCb) {
        syncCb.checked = false;
        syncOperationEnabled = false;
        syncCb.addEventListener('change', () => {
            if (syncCb.checked) {
                const selectedDevices = getSelectedDevices();
                if (selectedDevices.length === 0) {
                    showNotification('请先选中设备', null, 3000, 'warning');
                    syncCb.checked = false;
                    return;
                }
                syncOperationEnabled = true;
                showNotification(`已开启同步操作，将同步到 ${selectedDevices.length} 个设备`, null, 2000, 'success');
            } else {
                syncOperationEnabled = false;
                showNotification('已关闭同步操作', null, 2000, 'info');
            }
        });
    }
}

// 检查同步操作模式是否开启
function isSyncOperationEnabled() {
    return syncOperationEnabled;
}

// 切换设备选中状态
function toggleDeviceSelection(wrapper, card) {
    if (!wrapper || !card) return;
    const isSelected = wrapper.classList.contains('selected');
    if (isSelected) {
        wrapper.classList.remove('selected');
        card.classList.remove('selected');
    } else {
        wrapper.classList.add('selected');
        card.classList.add('selected');
    }
    // 更新全选复选框状态
    updateSelectAllCheckbox();
    // 触发设备选择变更回调
    triggerDeviceSelectionChange();
}

// 更新全选复选框状态
function updateSelectAllCheckbox() {
    const selectAllCheckbox = document.getElementById('select-all-devices');
    if (!selectAllCheckbox) return;

    const deviceWrappers = document.querySelectorAll('.device-card-wrapper');
    const selectedCount = document.querySelectorAll('.device-card-wrapper.selected').length;
    const totalCount = deviceWrappers.length;

    // 更新复选框状态
    if (selectedCount === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    } else if (selectedCount === deviceWrappers.length) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
    } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
    }

    // 更新 bar 里全局选中的文本
    const selectAllText = document.querySelector('#select-all-wrap .section-select-all-text');
    if (selectAllText) {
        selectAllText.textContent = selectedCount > 0 ? `选中(${selectedCount})` : '选中';
    }

    // 分栏模式下同步每栏「选中本栏」复选框状态
    if (getDevicesListViewMode() === 'sections') {
        const sectionsContainer = document.getElementById('devices-list-sections');
        if (sectionsContainer) {
            sectionsContainer.querySelectorAll('.devices-section').forEach(section => {
                const cb = section.querySelector('.section-select-all-checkbox');
                const grid = section.querySelector('.devices-section-list');
                if (!cb || !grid) return;
                const wrappers = grid.querySelectorAll('.device-card-wrapper');
                const n = wrappers.length;
                const sel = grid.querySelectorAll('.device-card-wrapper.selected').length;
                if (n === 0) {
                    cb.checked = false;
                    cb.indeterminate = false;
                } else if (sel === 0) {
                    cb.checked = false;
                    cb.indeterminate = false;
                } else if (sel === n) {
                    cb.checked = true;
                    cb.indeterminate = false;
                } else {
                    cb.checked = false;
                    cb.indeterminate = true;
                }
                const textEl = section.querySelector('.section-select-all-text');
                if (textEl) textEl.textContent = sel > 0 ? `选中(${sel})` : '选中';
            });
        }
    }

    // 更新设备状态显示
    updateDeviceStatusDisplay();
}

// 同步 bar 内「总的」状态（仅一个，放左边）；各 section 的 status 在 title 左侧由 createDevicesSection 已插入，此处仅兜底补全
function syncBarStatusDisplays(container, viewMode, orderedEndpointKeys) {
    const bar = document.getElementById('device-status-displays-bar');
    if (!bar) return;
    // bar 里只保留一个「总」状态
    let totalEl = bar.querySelector('.device-status-display-total');
    if (!totalEl) {
        bar.innerHTML = '';
        totalEl = document.createElement('span');
        totalEl.className = 'device-status-display device-status-display-total';
        bar.appendChild(totalEl);
    }
    // 兜底：旧 section 可能没有 .device-status-display-section 或 .endpoint-connection-status，补全
    container.querySelectorAll('.devices-section').forEach(section => {
        const titleRow = section.querySelector('.devices-section-title');
        if (!titleRow) return;
        const ep = section.dataset.endpoint || '';
        if (!titleRow.querySelector('.device-status-display-section')) {
            const span = document.createElement('span');
            span.className = 'device-status-display device-status-display-section';
            span.dataset.endpoint = ep;
            titleRow.insertBefore(span, titleRow.firstChild);
        }
        if (!titleRow.querySelector('.endpoint-connection-status')) {
            const span = document.createElement('span');
            span.className = 'endpoint-connection-status';
            span.dataset.endpoint = ep;
            span.title = '端点连接状态';
            const first = titleRow.querySelector('.device-status-display-section');
            first ? first.insertAdjacentElement('afterend', span) : titleRow.insertBefore(span, titleRow.firstChild);
        }
    });
}

// 更新设备状态显示：bar 左边为总统计；每个 section title 左侧为该端点统计
function updateDeviceStatusDisplay() {
    const bar = document.getElementById('device-status-displays-bar');
    const container = document.getElementById('devices-list-sections');
    if (!bar || !container) return;

    const setCounts = (el, cards) => {
        if (!el) return;
        let onlineCount = 0, offlineCount = 0;
        cards.forEach(card => {
            if (card.classList.contains('online')) onlineCount++;
            else if (card.classList.contains('offline')) offlineCount++;
        });
        el.textContent = `🟢 ${onlineCount} / 🔴 ${offlineCount} / 📱 ${cards.length}`;
    };

    const allCards = Array.from(container.querySelectorAll('.device-video-card'));
    const totalEl = bar.querySelector('.device-status-display-total');
    setCounts(totalEl, allCards);

    container.querySelectorAll('.devices-section').forEach(section => {
        const ep = section.dataset.endpoint;
        const statusEl = section.querySelector('.device-status-display-section');
        if (!statusEl) return;
        const grid = section.querySelector('.devices-section-list');
        const cards = grid ? Array.from(grid.querySelectorAll('.device-video-card')) : [];
        setCounts(statusEl, cards);
    });
}

// ---------- 端点管理 ----------
function updateDevicesViewModeUI() {
    const viewModeBtn = document.getElementById('devices-view-mode-btn');
    const toggleSectionsBtn = document.getElementById('devices-toggle-sections-btn');
    const isSections = getDevicesListViewMode() === 'sections';
    const iconSingle = viewModeBtn && viewModeBtn.querySelector('.view-mode-icon-single');
    const iconSections = viewModeBtn && viewModeBtn.querySelector('.view-mode-icon-sections');
    if (iconSingle) iconSingle.style.display = isSections ? '' : 'none';
    if (iconSections) iconSections.style.display = isSections ? 'none' : '';
    if (viewModeBtn) viewModeBtn.title = isSections ? '切换为单栏' : '切换为分栏';
    if (toggleSectionsBtn) toggleSectionsBtn.style.display = isSections ? '' : 'none';
}

let lastEndpointsList = [];

function buildEndpointConfigString(epInfo) {
    if (!epInfo || typeof epInfo !== 'object') return '';
    const host = epInfo.host != null ? String(epInfo.host) : '';
    const port = epInfo.port != null ? Number(epInfo.port) : 5037;
    const name = epInfo.endpoint != null ? String(epInfo.endpoint) : '';
    const parts = ['adb=' + host + ':' + port];
    if (name && name !== epInfo.id) parts.push('name=' + name);
    if (epInfo.retry != null && epInfo.retry !== undefined) parts.push('retry=' + epInfo.retry);
    if (epInfo.proxy) parts.push('proxy=' + epInfo.proxy);
    return parts.join(',');
}

async function showEndpointDetailModal(epInfoOrId) {
    const modal = document.getElementById('endpoint-detail-modal');
    if (!modal) return;
    let epInfo = typeof epInfoOrId === 'object' && epInfoOrId !== null ? epInfoOrId : null;
    if (!epInfo && typeof epInfoOrId === 'string') {
        epInfo = lastEndpointsList.find(ep => (ep.id && ep.id === epInfoOrId) || (ep.endpoint === epInfoOrId));
        if (!epInfo) {
            try {
                const res = await fetch('/api/endpoints');
                const data = await res.json().catch(() => ({}));
                const list = Array.isArray(data?.endpoints) ? data.endpoints : [];
                lastEndpointsList = list;
                epInfo = list.find(ep => (ep.id && ep.id === epInfoOrId) || (ep.endpoint === epInfoOrId));
            } catch (_) {}
        }
    }
    if (!epInfo) {
        showNotification('端点信息不可用', null, 2000, 'warning');
        return;
    }
    const nameEl = document.getElementById('ep-detail-name');
    const idEl = document.getElementById('ep-detail-id');
    const hostEl = document.getElementById('ep-detail-host');
    const portEl = document.getElementById('ep-detail-port');
    const proxyRow = document.getElementById('ep-detail-proxy-row');
    const proxyEl = document.getElementById('ep-detail-proxy');
    const retryRow = document.getElementById('ep-detail-retry-row');
    const retryEl = document.getElementById('ep-detail-retry');
    const configEl = document.getElementById('ep-detail-config');
    if (nameEl) nameEl.textContent = epInfo.endpoint != null ? epInfo.endpoint : (epInfo.id || '');
    if (idEl) idEl.textContent = epInfo.id != null ? epInfo.id : '';
    if (hostEl) hostEl.textContent = epInfo.host != null ? epInfo.host : '';
    if (portEl) portEl.textContent = epInfo.port != null ? String(epInfo.port) : '';
    const hasProxy = epInfo.proxy != null && String(epInfo.proxy).trim() !== '';
    if (proxyRow) { proxyRow.classList.toggle('has-value', hasProxy); if (proxyEl) proxyEl.textContent = hasProxy ? epInfo.proxy : ''; }
    const hasRetry = epInfo.retry != null && epInfo.retry !== undefined;
    if (retryRow) { retryRow.classList.toggle('has-value', hasRetry); if (retryEl) retryEl.textContent = hasRetry ? String(epInfo.retry) : ''; }
    const configStr = buildEndpointConfigString(epInfo);
    if (configEl) { configEl.textContent = configStr; configEl.title = configStr; }
    modal.classList.remove('hidden');
}

function initEndpointsPanel() {
    const connectBtn = document.getElementById('devices-connect-btn');
    const panel = document.getElementById('endpoints-panel');
    const closeBtn = document.getElementById('close-endpoints-btn');
    const addBtn = document.getElementById('endpoint-add-btn');
    const input = document.getElementById('endpoint-input');
    const toggleSectionsBtn = document.getElementById('devices-toggle-sections-btn');
    const viewModeBtn = document.getElementById('devices-view-mode-btn');

    if (viewModeBtn) {
        viewModeBtn.addEventListener('click', () => {
            setDevicesListViewMode(getDevicesListViewMode() === 'sections' ? 'single-grid' : 'sections');
            updateDevicesViewModeUI();
            loadDevices(false);
        });
        updateDevicesViewModeUI();
    }

    if (toggleSectionsBtn) {
        toggleSectionsBtn.addEventListener('click', () => {
            const sections = document.querySelectorAll('.devices-section');
            const anyExpanded = Array.from(sections).some(s => !s.classList.contains('devices-section-collapsed'));
            const collapse = anyExpanded;
            sections.forEach(section => {
                if (collapse) {
                    section.classList.add('devices-section-collapsed');
                    const arrow = section.querySelector('.devices-section-arrow');
                    if (arrow) {
                        arrow.textContent = '▶';
                        arrow.setAttribute('aria-expanded', 'false');
                    }
                } else {
                    section.classList.remove('devices-section-collapsed');
                    const arrow = section.querySelector('.devices-section-arrow');
                    if (arrow) {
                        arrow.textContent = '▼';
                        arrow.setAttribute('aria-expanded', 'true');
                    }
                }
            });
            const iconCollapse = toggleSectionsBtn.querySelector('.toggle-sections-icon-collapse');
            const iconExpand = toggleSectionsBtn.querySelector('.toggle-sections-icon-expand');
            if (iconCollapse) iconCollapse.style.display = collapse ? 'none' : '';
            if (iconExpand) iconExpand.style.display = collapse ? '' : 'none';
            toggleSectionsBtn.title = collapse ? '展开全部' : '收起全部';
        });
    }

    if (!connectBtn || !panel || !closeBtn || !addBtn || !input) return;
    input.placeholder = ENDPOINT_FORMAT_HINT;

    const detailModal = document.getElementById('endpoint-detail-modal');
    const closeDetailBtn = document.getElementById('close-endpoint-detail-modal');
    const copyDetailBtn = document.getElementById('ep-detail-copy-btn');
    if (detailModal && closeDetailBtn) {
        closeDetailBtn.addEventListener('click', () => detailModal.classList.add('hidden'));
    }
    if (copyDetailBtn) {
        copyDetailBtn.addEventListener('click', () => {
            const configEl = document.getElementById('ep-detail-config');
            const text = configEl ? configEl.textContent || '' : '';
            if (!text) return;
            navigator.clipboard.writeText(text).then(() => showNotification('已复制', null, 1500, 'success')).catch(() => showNotification('复制失败', null, 2000, 'error'));
        });
    }
    connectBtn.addEventListener('click', () => {
        panel.classList.remove('hidden');
        loadEndpoints();
    });
    closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
    addBtn.addEventListener('click', () => addEndpoint());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addEndpoint(); });
}

async function loadEndpoints() {
    const listEl = document.getElementById('endpoints-list');
    if (!listEl) return;
    try {
        const res = await fetch('/api/endpoints');
        const data = await res.json().catch(() => ({}));
        const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : (Array.isArray(data) ? data : []);
        const addEl = document.querySelector('.endpoints-add');
        const hintEl = document.querySelector('.endpoints-format-hint');
        const allowEdit = data.endpointsMutable !== false;
        lastEndpointsList = endpoints;
        if (addEl) addEl.style.display = allowEdit ? '' : 'none';
        if (hintEl) hintEl.style.display = allowEdit ? '' : 'none';
        listEl.innerHTML = '';
        if (endpoints.length === 0) {
            listEl.innerHTML = '<li class="endpoints-empty" style="color:#999;padding:12px;">暂无端点</li>';
            return;
        }
        endpoints.forEach(epInfo => {
            const li = document.createElement('li');
            let displayText, endpointValue, fullText;
            if (typeof epInfo === 'string') {
                fullText = epInfo;
                displayText = epInfo;
                endpointValue = epInfo;
            } else {
                const id = epInfo.id || '';
                const name = epInfo.endpoint || ''; // 后端：有 name 时 endpoint 为 name，否则为 id
                const hostPort = (epInfo.host != null && epInfo.port != null) ? `${epInfo.host}:${epInfo.port}` : '';
                endpointValue = id || hostPort;
                fullText = name && name !== id ? `${name} (${id})` : (id || hostPort);
                displayText = fullText;
            }
            
            // 限制显示长度为 30 个字符
            const truncatedText = displayText.length > 30 ? displayText.substring(0, 30) + '...' : displayText;
            const deleteBtnHtml = allowEdit ? `<button class="endpoint-delete" data-endpoint="${escapeHtml(endpointValue)}" title="断开/删除">⛓️‍💥</button>` : '';
            li.innerHTML = `<button type="button" class="endpoint-info-btn" title="查看详情" aria-label="查看详情">ℹ️</button><span class="endpoint-item-text" title="${escapeHtml(fullText)}">${escapeHtml(truncatedText)}</span>${deleteBtnHtml}`;
            const infoBtn = li.querySelector('.endpoint-info-btn');
            if (infoBtn) infoBtn.addEventListener('click', (e) => { e.stopPropagation(); showEndpointDetailModal(epInfo); });
            if (allowEdit) {
                li.querySelector('.endpoint-delete').addEventListener('click', () => {
                    if (!confirm(`确定删除端点 ${fullText}？`)) return;
                    deleteEndpoint(endpointValue);
                });
            }
            listEl.appendChild(li);
        });
    } catch (e) {
        listEl.innerHTML = '<li class="endpoints-empty" style="color:#e74c3c;">请求失败</li>';
    }
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

async function addEndpoint() {
    const input = document.getElementById('endpoint-input');
    if (!input) return;
    const value = (input.value || '').trim();
    if (!value) return;
    try {
        const res = await fetch('/api/endpoints', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: value })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showNotification(data.error || '添加失败', null, 2000, 'error');
            return;
        }
        showNotification('已添加端点', null, 2000, 'success');
        input.value = '';
        loadEndpoints();
        loadDevices();
    } catch (e) {
        showNotification('请求失败', null, 2000, 'error');
    }
}

async function deleteEndpoint(endpoint) {
    try {
        const res = await fetch('/api/endpoints/' + encodeURIComponent(endpoint), { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showNotification(data.error || '删除失败', null, 2000, 'error');
            return;
        }
        showNotification('已删除端点', null, 2000, 'success');
        await loadEndpoints();
        await loadDevices(false);
    } catch (e) {
        showNotification('请求失败', null, 2000, 'error');
    }
}

// 统一的通知函数
// showNotification(message, deviceUDID?, duration?, type?)
function showNotification(message, deviceUDID = null, duration = 2000, type = 'info') {
    // 如果第二个参数是字符串且不是设备UDID格式，可能是旧的调用方式 (message, type)
    if (typeof deviceUDID === 'string' && deviceUDID !== null && 
        (deviceUDID === 'success' || deviceUDID === 'error' || deviceUDID === 'info' || deviceUDID === 'warning')) {
        // 旧格式：showNotification(message, type)
        type = deviceUDID;
        deviceUDID = null;
        duration = 2000;
    }
    
    // 如果提供了设备UDID，检查是否在全屏模式下
    if (deviceUDID && currentFullscreenDeviceUDID === deviceUDID) {
        // 全屏模式下，在全屏视频容器中显示
        const focusVideoWrapper = document.getElementById('focus-video-wrapper');
        if (focusVideoWrapper) {
            showNotificationAtPosition(message, focusVideoWrapper, duration, type);
            return;
        }
    }
    
    // 如果提供了设备UDID，尝试在设备卡片中心显示
    if (deviceUDID) {
        const wrapper = document.querySelector(`.device-card-wrapper[data-udid="${CSS.escape(deviceUDID)}"]`);
        if (wrapper) {
            const videoContainer = wrapper.querySelector('.device-video-container');
            const container = videoContainer || wrapper;
            showNotificationAtPosition(message, container, duration, type);
            return;
        }
    }
    
    // 默认在页面右上角显示
    showNotificationAtPosition(message, null, duration, type);
}


// 移除设备卡片（在按端点分组的列表中查找）
function removeDeviceCard(deviceUDIDOrDeviceId) {
    const container = document.getElementById('devices-list-sections');
    const wrapper = container ? (container.querySelector(`.device-card-wrapper[data-device-id="${CSS.escape(deviceUDIDOrDeviceId)}"]`) || container.querySelector(`.device-card-wrapper[data-udid="${CSS.escape(deviceUDIDOrDeviceId)}"]`)) : null;
    if (wrapper) {
        const deviceId = wrapper.dataset.deviceId;
        const apiUdid = getApiUdidForCard(wrapper);
        deviceRegistry.delete(deviceId);
        deviceConnectionStates.delete(apiUdid);
        const gridItem = wrapper.closest('.device-grid-item');
        if (gridItem) gridItem.remove();
        else wrapper.remove();
    }
    updateDeviceStatusDisplay();
}

// 更新设备卡片状态（入参为 wrapper；同步注册表、DOM 与名称区图标）
function updateDeviceCardStatus(wrapper, device) {
    const card = wrapper && wrapper.querySelector('.device-video-card');
    if (!card) return;
    const deviceId = getDeviceId(device);
    const apiUdid = getDeviceApiUdid(device);
    deviceRegistry.set(deviceId, { apiUdid });
    wrapper.dataset.udid = apiUdid;
    card.dataset.udid = apiUdid;
    if (device.status) {
        card.classList.remove('online', 'offline', 'busy');
        card.classList.add(device.status);
        card.dataset.status = device.status;
    }
    if (device.name != null) card.dataset.deviceName = device.name;
    const nameElement = card.querySelector('.device-video-name');
    if (nameElement) {
        const deviceName = device.name || device.udid;
        const connectionState = deviceConnectionStates.get(apiUdid);
        let statusIcon = connectionState === DeviceConnectionState.CONNECTING ? '🟡' : connectionState === DeviceConnectionState.CONNECTED ? '🟢' : (device.status === 'online' ? '🟢' : device.status === 'offline' ? '🔴' : '🟡');
        nameElement.innerHTML = renderDeviceNameWithStatusHTML(deviceName, statusIcon, false);
    }
}

// 创建设备卡片（带视频流）；deviceId 指代设备，API udid 存注册表，DOM id 用 deviceId 避免拔插后变
function createDeviceCard(device) {
    const deviceId = getDeviceId(device);
    const apiUdid = getDeviceApiUdid(device);
    deviceRegistry.set(deviceId, { apiUdid });

    const wrapper = document.createElement('div');
    wrapper.className = 'device-card-wrapper';
    wrapper.dataset.deviceId = deviceId;
    wrapper.dataset.udid = apiUdid; // 显示用，请求用 getApiUdidForCard(wrapper)
    wrapper.deviceData = device;

    const card = document.createElement('div');
    card.className = `device-video-card ${device.status}`;
    card.dataset.deviceId = deviceId;
    card.dataset.udid = apiUdid;
    card.dataset.status = device.status;
    card.dataset.deviceName = device.name || device.udid;
    card.dataset.model = device.model || '未知型号';

    const safeId = safeIdFromUdid(deviceId);
    const statusIcon = device.status === 'online' ? '🟢' : device.status === 'offline' ? '🔴' : '🟡';
    card.innerHTML = `
        <div class="device-video-header">
            <div class="device-video-name">${renderDeviceNameWithStatusHTML(device.name || device.udid, statusIcon, false)}</div>
        </div>
        <button class="control-btn-icon fullscreen-btn" data-device-id="${escapeHtml(deviceId)}" title="全屏放大" style="position: absolute; top: 8px; right: 40px; z-index: 99; width: 24px; height: 24px; background: rgba(255, 255, 255, 0.2); border: none; border-radius: 50%; color: white; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); transition: opacity 0.3s ease; font-weight: bold;">⛶</button>
        <div class="device-video-container" id="video-container-${safeId}" tabindex="-1">
            <div class="device-video-wrapper" id="video-wrapper-${safeId}">
                ${getLoadingStateHTML(device.model || '未知型号', apiUdid)}
            </div>
            <div class="device-control-panel-bottom" id="control-panel-bottom-${safeId}">
                <button class="control-btn-icon" data-action="back" title="返回" disabled>←</button>
                <button class="control-btn-icon" data-action="home" title="主页" disabled>🏠</button>
                <button class="control-btn-icon" data-action="menu" title="最近任务" disabled>☰</button>
            </div>
        </div>
    `;

    const rightPanel = document.createElement('div');
    rightPanel.className = 'device-control-panel';
    rightPanel.id = `control-panel-${safeId}`;
    rightPanel.innerHTML = `
        <button class="control-btn-icon info-btn" data-device-id="${escapeHtml(deviceId)}" title="设备信息">ℹ️</button>
        <button class="control-btn-icon disconnect-btn" data-device-id="${escapeHtml(deviceId)}" title="连接">🔗</button>
        <button class="control-btn-icon shell-btn" data-device-id="${escapeHtml(deviceId)}" title="Shell">💻</button>
        <button class="control-btn-icon" data-action="notification-panel" title="通知面板" disabled>📢</button>
        <button class="control-btn-icon" data-action="settings-panel" title="设置面板" disabled>⚙️</button>
        <button class="control-btn-icon" data-action="collapse-panels" title="收起面板" disabled>⬇️</button>
        <button class="control-btn-icon" data-action="text-input-panel" title="文本输入" disabled>⌨️</button>
        <button class="control-btn-icon" data-action="screen-off" title="关闭屏幕" disabled>💤</button>
        <button class="control-btn-icon" data-action="screen-on" title="唤醒屏幕" disabled>☀️</button>
        <button class="control-btn-icon" data-action="power" title="电源" disabled>⏻</button>
        <button class="control-btn-icon" data-action="volume-up" title="音量+" disabled>🔊</button>
        <button class="control-btn-icon" data-action="volume-down" title="音量-" disabled>🔉</button>
        <button class="control-btn-icon" data-action="mute" title="静音" disabled>🔇</button>
        <button class="control-btn-icon audio-toggle-btn" data-action="audio-toggle" data-audio-enabled="0" title="网页播放设备声音（需先投屏）" disabled>👂</button>
        <button class="control-btn-icon" data-action="rotate-view" data-device-id="${escapeHtml(deviceId)}" title="旋转视图" disabled>🔄</button>
    `;
    
    // 组装结构
    wrapper.appendChild(card);
    wrapper.appendChild(rightPanel);
    
    // 绑定事件
    const fullscreenBtn = card.querySelector('.fullscreen-btn');
    const infoBtn = rightPanel.querySelector('.info-btn');
    const startStreamBtn = card.querySelector('.start-stream-btn');
    const disconnectBtn = rightPanel.querySelector('.disconnect-btn');
    
    // 全屏：从 wrapper 取 deviceId，入口统一用 deviceId
    if (fullscreenBtn) {
        fullscreenBtn.onclick = (e) => {
            e.stopPropagation();
            const w = e.currentTarget && e.currentTarget.closest('.device-card-wrapper');
            const deviceId = w ? w.dataset.deviceId : '';
            if (!deviceId) return;
            const apiUdid = getApiUdidForCard(w);
            if (currentFullscreenDeviceUDID === apiUdid) exitFullscreenMode();
            else enterFullscreenMode(deviceId);
        };
    }
    if (infoBtn) {
        infoBtn.onclick = (e) => {
            e.stopPropagation();
            showDeviceModal(device);
        };
    }
    const shellBtn = rightPanel.querySelector('.shell-btn');
    if (shellBtn) {
        shellBtn.onclick = (e) => {
            e.stopPropagation();
            const apiUdid = getApiUdidFromButton(e.currentTarget);
            const name = (wrapper.deviceData && (wrapper.deviceData.name || wrapper.deviceData.udid)) || device.name || device.udid;
            if (apiUdid) openShellPanel(apiUdid, name, e);
        };
    }
    if (disconnectBtn) {
        disconnectBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const apiUdid = getApiUdidFromButton(e.currentTarget);
            if (apiUdid) handleDisconnectClick(apiUdid);
        };
    }
    startStreamBtn.onclick = (e) => {
        e.stopPropagation();
        const w = e.currentTarget && e.currentTarget.closest('.device-card-wrapper');
        if (!w) return;
        const c = w.querySelector('.device-video-card');
        const apiUdid = getApiUdidForCard(w);
        const videoWrapper = c && c.querySelector('.device-video-wrapper');
        if (apiUdid && videoWrapper) startDeviceStream(apiUdid, videoWrapper);
    };
    
    // 点击标题栏或绿色勾可以选中/取消选中（不影响video区域）
    const header = card.querySelector('.device-video-header');
    if (header) {
        header.onclick = (e) => {
            // 如果点击的是按钮，不处理
            if (e.target.closest('button')) {
                return;
            }
            e.stopPropagation(); // 阻止事件冒泡到card
            toggleDeviceSelection(wrapper, card);
        };
        // 添加鼠标样式提示用户可以点击
        header.style.cursor = 'pointer';
    }
    
    // 给整个卡片添加点击事件（排除video区域和按钮）
    card.onclick = (e) => {
        // 如果点击的是video区域、按钮区域或控制面板，不处理
        if (e.target.closest('.device-video-wrapper') || 
            e.target.closest('.device-video-container') ||
            e.target.closest('button') ||
            e.target.closest('.device-control-panel-bottom') ||
            e.target.closest('.device-control-panel')) {
            return;
        }
        // 如果点击的是标题栏，已经处理过了，不重复处理
        if (e.target.closest('.device-video-header')) {
            return;
        }
        e.stopPropagation();
        toggleDeviceSelection(wrapper, card);
    };
    
    // 添加鼠标样式提示用户可以点击（除了video区域）
    card.style.cursor = 'pointer';
    
    setTimeout(() => setupControlButtons(deviceId), 0);
    deviceConnectionStates.set(apiUdid, DeviceConnectionState.DISCONNECTED);
    return wrapper;
}

// 获取状态文本
function getStatusText(status) {
    const statusMap = {
        'online': '在线',
        'offline': '离线',
        'busy': '忙碌'
    };
    return statusMap[status] || status;
}

// Shell 多窗口：每个窗口独立 ws，可拖动，点击置顶（同 z-index 时 DOM 靠后的在上，故 appendChild 即可）
let shellWindowCount = 0;

function bringShellWindowToFront(win) {
    const container = document.getElementById('shell-windows-container');
    if (container && win.parentNode === container) container.appendChild(win);
}

function initShellPanel() {
    // 仅确保容器存在，窗口由 openShellPanel 动态创建
}

function openShellPanel(udid, deviceName, clickEvent) {
    const container = document.getElementById('shell-windows-container');
    if (!container) return;
    if (typeof Terminal === 'undefined') {
        console.error('xterm.js 未加载');
        return;
    }
    shellWindowCount += 1;
    const id = `shell-window-${shellWindowCount}`;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/device/${encodeURIComponent(udid)}/adb/shell`;
    const displayName = deviceName && deviceName !== udid ? escapeHtml(deviceName) : '';
    const displayUdid = escapeHtml(udid);

    const win = document.createElement('div');
    win.className = 'shell-window';
    win.id = id;
    win.dataset.udid = udid;
    win.innerHTML = `
        <div class="shell-window-header">
            <h3 class="shell-window-title">💻 Shell · ${displayName ? `<span class="shell-title-name">${displayName}</span> <span class="shell-title-udid">${displayUdid}</span>` : `<span class="shell-title-udid">${displayUdid}</span>`}</h3>
            <div class="shell-window-header-btns">
                <button class="shell-window-collapse-btn" title="收起">
                    <svg class="shell-btn-icon shell-btn-icon-down" viewBox="0 0 12 8" width="12" height="8"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M1 2l5 4 5-4"/></svg>
                    <svg class="shell-btn-icon shell-btn-icon-up" viewBox="0 0 12 8" width="12" height="8" style="display:none"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M1 6l5-4 5 4"/></svg>
                </button>
                <button class="close-btn" title="关闭">
                    <svg class="shell-btn-icon" viewBox="0 0 12 12" width="12" height="12"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M2 2l8 8M10 2L2 10"/></svg>
                </button>
            </div>
        </div>
        <div class="shell-window-content shell-terminal-wrap"></div>
        <div class="shell-window-resize-handle" title="拖动调整大小"></div>
    `;

    const termEl = win.querySelector('.shell-terminal-wrap');
    const header = win.querySelector('.shell-window-header');
    const closeBtn = win.querySelector('.close-btn');
    const collapseBtn = win.querySelector('.shell-window-collapse-btn');

    const winW = 640;
    const winH = 480;
    const titleBarHalf = 21;
    let left, top;
    if (clickEvent && typeof clickEvent.clientX === 'number') {
        left = clickEvent.clientX - winW / 2;
        top = clickEvent.clientY - titleBarHalf;
        left = Math.max(8, Math.min(left, window.innerWidth - winW - 8));
        top = Math.max(8, Math.min(top, window.innerHeight - winH - 8));
    } else {
        const offset = (shellWindowCount - 1) % 5;
        left = 80 + offset * 24;
        top = 60 + offset * 24;
    }
    win.style.left = `${left}px`;
    win.style.top = `${top}px`;

    container.appendChild(win);
    // 只有点标题等非终端区才置顶；点终端黑区不移动 DOM，并显式把焦点给 xterm（Mac 上依赖焦点）
    win.addEventListener('mousedown', (e) => {
        if (e.target.closest('.shell-terminal-wrap')) {
            if (win._shellTerminal) win._shellTerminal.focus();
        } else {
            bringShellWindowToFront(win);
        }
    });

    // xterm 依赖焦点：内部用隐藏 textarea 收键盘，term.focus() 聚焦它，Mac 上必须显式设焦点
    const term = new Terminal({
        theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
        fontSize: 13,
        fontFamily: 'Consolas, Monaco, monospace',
        scrollback: 2000
    });
    term.open(termEl);
    win._shellTerminal = term;
    win._shellTermEl = termEl;
    fitShellTerminal(term, termEl, win, false);
    const ro = new ResizeObserver(() => fitShellTerminal(term, termEl, win, false));
    ro.observe(termEl);
    win._shellResizeObserver = ro;
    termEl.addEventListener('click', () => { term.focus(); });
    termEl.addEventListener('mousedown', () => { term.focus(); });
    setTimeout(() => term.focus(), 0);

    const ws = new WebSocket(wsUrl);
    win._shellWs = ws;

    term.onData((data) => {
        if (data === '\x1d') {
            closeShellWindow(win);
            return;
        }
        if (ws.readyState === 1) ws.send(data);
    });

    ws.onopen = () => {
        term.clear();
    };
    ws.onmessage = (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
        term.write(text);
    };
    ws.onerror = () => {
        term.writeln('\r\n[连接错误]');
    };
    ws.onclose = () => {
        term.writeln('\r\n[已断开]');
        win._shellWs = null;
    };

    collapseBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    collapseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isCollapsing = !win.classList.contains('shell-window-collapsed');
        if (isCollapsing) {
            win._shellSavedHeight = win.style.height || (win.getBoundingClientRect().height + 'px');
            win.style.height = 'auto';
            win.style.minHeight = '0';
        } else {
            win.style.height = win._shellSavedHeight != null ? win._shellSavedHeight : '';
            win.style.minHeight = '';
        }
        win.classList.toggle('shell-window-collapsed');
        collapseBtn.title = win.classList.contains('shell-window-collapsed') ? '展开' : '收起';
        const iconDown = collapseBtn.querySelector('.shell-btn-icon-down');
        const iconUp = collapseBtn.querySelector('.shell-btn-icon-up');
        if (iconDown && iconUp) {
            iconDown.style.display = win.classList.contains('shell-window-collapsed') ? 'none' : '';
            iconUp.style.display = win.classList.contains('shell-window-collapsed') ? '' : 'none';
        }
        if (!win.classList.contains('shell-window-collapsed') && win._shellTerminal && win._shellTermEl) fitShellTerminal(win._shellTerminal, win._shellTermEl, win, false);
    });
    closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeShellWindow(win);
    });
    setupShellWindowDrag(win, header);
    setupShellWindowResize(win);
}

// 发送 shell 终端尺寸到后端，协议：BinaryMessage，首字节 0x01，随后 4 字节 cols + 4 字节 rows（大端）
function sendShellResize(ws, cols, rows) {
    if (!ws || ws.readyState !== 1) return;
    const buf = new ArrayBuffer(9);
    const view = new DataView(buf);
    view.setUint8(0, 0x01);
    view.setUint32(1, cols, false);
    view.setUint32(5, rows, false);
    ws.send(buf);
}

// sendResize: 是否把 cols/rows 发给后端（仅拖拽松开时 true，避免拖拽过程中刷一堆 stty）
function fitShellTerminal(term, container, win, sendResize) {
    if (!container || !container.isConnected) return;
    // 列数必须按「可见区」算：viewport 出现纵向滚动条时 clientWidth 会小于外层，否则长行会画进滚动条带（非 xterm bug，是宽度量错）
    const vp = term.element && term.element.querySelector('.xterm-viewport');
    let w = container.clientWidth;
    if (vp && vp.clientWidth > 0) w = vp.clientWidth;
    const h = container.clientHeight;
    if (w <= 0 || h <= 0) return;
    const fontSize = (typeof term.getOption === 'function' && term.getOption('fontSize')) || 13;
    const fontFamily = (typeof term.getOption === 'function' && term.getOption('fontFamily')) || 'Consolas, Monaco, monospace';
    const measure = document.createElement('span');
    measure.style.cssText = 'position:absolute;visibility:hidden;top:0;left:0;white-space:pre;font:' + fontSize + 'px ' + fontFamily;
    measure.textContent = 'M';
    document.body.appendChild(measure);
    let charWidth = measure.offsetWidth || 8;
    let lineHeight = Math.ceil(fontSize * 1.35) || 16;
    document.body.removeChild(measure);
    // 与 xterm 内部渲染单元格对齐，避免 viewport 高于 screen 露出默认黑底
    const screenEl = term.element && term.element.querySelector('.xterm-screen');
    const prevCols = term.cols;
    const prevRows = term.rows;
    if (screenEl && prevCols > 0 && prevRows > 0) {
        const cw = screenEl.clientWidth / prevCols;
        const lh = screenEl.clientHeight / prevRows;
        if (cw > 0) charWidth = cw;
        if (lh > 0) lineHeight = lh;
    }
    const cols = Math.max(2, Math.floor(w / charWidth));
    const rows = Math.max(2, Math.floor((h - 4) / lineHeight));
    term.resize(cols, rows);
    if (sendResize && win && win._shellWs && win._shellWs.readyState === 1) sendShellResize(win._shellWs, cols, rows);
}

function setupShellWindowResize(win) {
    const handle = win.querySelector('.shell-window-resize-handle');
    if (!handle) return;
    let resizing = false;
    let startX = 0, startY = 0, startW = 0, startH = 0;
    const onMove = (e) => {
        if (!resizing) return;
        const dw = e.clientX - startX;
        const dh = e.clientY - startY;
        let w = startW + dw;
        let h = startH + dh;
        const minW = 320, minH = 240;
        w = Math.max(minW, w);
        h = Math.max(minH, h);
        win.style.width = w + 'px';
        win.style.height = h + 'px';
        if (win._shellTerminal && win._shellTermEl) fitShellTerminal(win._shellTerminal, win._shellTermEl, win, false);
    };
    const onUp = () => {
        if (!resizing) return;
        resizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (win._shellTerminal && win._shellTermEl) fitShellTerminal(win._shellTerminal, win._shellTermEl, win, true);
    };
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        resizing = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = win.getBoundingClientRect();
        startW = rect.width;
        startH = rect.height;
        document.body.style.cursor = 'nwse-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function closeShellWindow(win) {
    if (currentActiveShellWindow === win) currentActiveShellWindow = null;
    if (win._shellResizeObserver && win._shellTermEl) {
        win._shellResizeObserver.unobserve(win._shellTermEl);
    }
    if (win._shellWs) {
        win._shellWs.close();
        win._shellWs = null;
    }
    if (win._shellTerminal) {
        win._shellTerminal.dispose();
        win._shellTerminal = null;
    }
    win.remove();
}

function setupShellWindowDrag(win, header) {
    let drag = { active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 };
    const onMove = (e) => {
        if (!drag.active) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        win.style.left = `${drag.startLeft + dx}px`;
        win.style.top = `${drag.startTop + dy}px`;
    };
    const onUp = () => {
        if (!drag.active) return;
        drag.active = false;
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };
    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        bringShellWindowToFront(win);
        drag.active = true;
        drag.startX = e.clientX;
        drag.startY = e.clientY;
        const rect = win.getBoundingClientRect();
        drag.startLeft = rect.left;
        drag.startTop = rect.top;
        document.body.style.cursor = 'move';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// 根据 device_status 的 data 构建当前应使用的 apiUdid（拔插后 transport_id 会变，需与后端一致）
function buildApiUdidFromDeviceData(deviceData, existingCardUdid) {
    const serial = deviceData.udid || '';
    const tid = deviceData.transport_id != null && deviceData.transport_id > 0 ? deviceData.transport_id : 0;
    const base = serial + (tid ? ':' + tid : '');
    const atIdx = (existingCardUdid || '').indexOf('@');
    return atIdx >= 0 ? base + existingCardUdid.slice(atIdx) : base;
}

// 更新设备状态（数据源：注册表；WebSocket 只发 serial，用 findWrappersBySerial 找卡片）
function updateDeviceStatus(udid, deviceData) {
    if (!deviceData) return;
    const wrappers = findWrappersBySerial(udid);
    if (wrappers.length === 0) {
        if (deviceData.status === 'offline') return;
        if (deviceData.status === 'online') loadDevices(false);
        return;
    }
    wrappers.forEach(wrapper => {
        const card = wrapper.querySelector('.device-video-card');
        if (!card) return;
        const deviceId = wrapper.dataset.deviceId || '';
        const oldEntry = deviceRegistry.get(deviceId);
        const oldApiUdid = (oldEntry && oldEntry.apiUdid) || wrapper.dataset.udid || udid;
        const newApiUdid = buildApiUdidFromDeviceData(deviceData, deviceId);
        deviceRegistry.set(deviceId, { apiUdid: newApiUdid });
        wrapper.dataset.udid = newApiUdid;
        card.dataset.udid = newApiUdid;
        if (wrapper.deviceData) {
            wrapper.deviceData.udid = deviceData.udid || wrapper.deviceData.udid;
            wrapper.deviceData.transport_id = deviceData.transport_id != null ? deviceData.transport_id : wrapper.deviceData.transport_id;
        }
        const apiUdid = newApiUdid;
        const connectionState = deviceConnectionStates.get(oldApiUdid) ?? deviceConnectionStates.get(apiUdid);
        if (oldApiUdid !== newApiUdid && deviceConnectionStates.has(oldApiUdid)) {
            deviceConnectionStates.set(newApiUdid, deviceConnectionStates.get(oldApiUdid));
            deviceConnectionStates.delete(oldApiUdid);
        }
        // 更新卡片的状态类
        if (deviceData.status) {
            // 更新卡片的 className（移除旧的状态类，添加新的）
            card.classList.remove('online', 'offline', 'busy');
            card.classList.add(deviceData.status);
            card.dataset.status = deviceData.status;
        }
        
        // 更新设备名称（如果提供了）
        if (deviceData.name) {
            card.dataset.deviceName = deviceData.name;
        }
        
        // 如果设备状态变为 offline，且当前有连接，需要清理连接并恢复UI
        if (deviceData.status === 'offline' && 
            (connectionState === DeviceConnectionState.CONNECTING || connectionState === DeviceConnectionState.CONNECTED)) {
            // 设备断开，清理连接并恢复未连接状态
            if (activeWebRTCConnections.has(apiUdid)) {
                cleanupWebRTCConnection(apiUdid);
            } else {
                setDeviceConnectionState(apiUdid, DeviceConnectionState.DISCONNECTED);
                restoreConnectionUI(apiUdid);
            }
        }
        const nameElement = card.querySelector('.device-video-name');
        if (nameElement) {
            const deviceName = deviceData.name || card.dataset.deviceName || deviceData.udid || udid;
            const currentConnectionState = deviceConnectionStates.get(apiUdid);
            // 根据连接状态改变状态图标颜色
            let statusIcon;
            if (currentConnectionState === DeviceConnectionState.CONNECTING) {
                // 连接中：黄灯
                statusIcon = '🟡';
            } else if (currentConnectionState === DeviceConnectionState.CONNECTED) {
                // 已连接：绿灯
                statusIcon = '🟢';
            } else {
                // 未连接：根据设备状态显示
                const deviceStatus = deviceData.status || card.dataset.status || 'unknown';
                statusIcon = deviceStatus === 'online' ? '🟢' : deviceStatus === 'offline' ? '🔴' : '🟡';
            }
            nameElement.innerHTML = renderDeviceNameWithStatusHTML(deviceName, statusIcon, false);
        }
    });
    updateDeviceStatusDisplay();
}

// 设置设备连接状态（唯一入口；连接/断开与按钮启用/禁用由此统一驱动）
function setDeviceConnectionState(deviceUDID, state) {
    deviceConnectionStates.set(deviceUDID, state);
    updateConnectionStateUI(deviceUDID, state);
    syncControlButtonsToConnectionState(deviceUDID);
    updateDeviceStatusDisplay();
}

// 根据当前连接状态同步所有控制按钮的启用/禁用（卡片 + 全屏）
function syncControlButtonsToConnectionState(deviceUDID) {
    const enabled = (getDeviceConnectionState(deviceUDID) === DeviceConnectionState.CONNECTED);
    updateControlButtonsState(deviceUDID, enabled);
}

// 获取设备连接状态
function getDeviceConnectionState(deviceUDID) {
    return deviceConnectionStates.get(deviceUDID) || DeviceConnectionState.DISCONNECTED;
}

// 更新连接状态UI（deviceUDID 为当前 apiUdid）
function updateConnectionStateUI(deviceUDID, state) {
    const wrapper = findWrapperByApiUdid(deviceUDID);
    const card = wrapper ? wrapper.querySelector('.device-video-card') : null;
    if (!card) return;
    
    const nameElement = card.querySelector('.device-video-name');
    if (!nameElement) return;
    
    // 获取设备状态（在线/离线）
    const deviceStatus = card.classList.contains('online') ? 'online' : 
                        card.classList.contains('offline') ? 'offline' : 'busy';
    
    // 获取设备名称
    const deviceName = card.dataset.deviceName || deviceUDID;
    
    // 根据连接状态改变状态图标颜色（不显示文字）
    let statusIcon;
    if (state === DeviceConnectionState.CONNECTING) {
        // 连接中：黄灯
        statusIcon = '🟡';
    } else if (state === DeviceConnectionState.CONNECTED) {
        // 已连接：绿灯
        statusIcon = '🟢';
    } else {
        // 未连接：根据设备状态显示
        statusIcon = deviceStatus === 'online' ? '🟢' : deviceStatus === 'offline' ? '🔴' : '🟡';
    }
    
    nameElement.innerHTML = renderDeviceNameWithStatusHTML(deviceName, statusIcon, true);
    
    // 更新断开连接按钮（侧栏复用同一套 DOM，无需单独刷新全屏）
    updateDisconnectButton(deviceUDID, state);
    
    // 保存设备名称到dataset（用于后续更新）
    if (card) {
        card.dataset.deviceName = deviceName;
    }
}

// 启动设备视频流
function startDeviceStream(deviceUDID, container) {
    // 如果已有连接，不重复创建
    if (activeWebRTCConnections.has(deviceUDID)) {
        console.log(`设备 ${deviceUDID} 已有视频流连接`);
        return;
    }
    
    // 设置连接状态为连接中
    setDeviceConnectionState(deviceUDID, DeviceConnectionState.CONNECTING);
    
    // 确保使用正确的容器（对应设备的video-wrapper）
    container = getCorrectContainer(deviceUDID, container);
    // 启动视频流
    
    // 只清空 video-wrapper 的内容，保留按钮
    const videoWrapper = container.querySelector('.device-video-wrapper') || container;
    videoWrapper.innerHTML = '<div class="loading-state"><p>⏳ 正在启动视频流...</p></div>';
    
    // 如果当前在全屏模式，也更新全屏界面的加载状态
    if (currentFullscreenDeviceUDID === deviceUDID) {
        const focusVideoWrapper = document.getElementById('focus-video-wrapper');
        if (focusVideoWrapper) {
            const loadingState = document.createElement('div');
            loadingState.className = 'loading-state';
            loadingState.style.cssText = `
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                color: #fff;
                text-align: center;
                padding: 40px;
                height: 100%;
            `;
            loadingState.innerHTML = '<p>⏳ 正在启动视频流...</p>';
            focusVideoWrapper.innerHTML = '';
            focusVideoWrapper.appendChild(loadingState);
        }
    }
    
    // 根据平台选择流类型
    fetch(`/api/device/${encodeURIComponent(deviceUDID)}`)
        .then(res => {
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }
            return res.json();
        })
        .then(device => {
            // API直接返回设备对象，不是包装在 {device: ...} 中
            if (!device) {
                throw new Error('设备数据格式错误');
            }
            initWebRTCStream(deviceUDID, container);
        })
        .catch(err => {
            console.error(`获取设备信息失败: ${err}`);
            videoWrapper.innerHTML = createErrorStateHTML('❌ 无法获取设备信息', err.message || err.toString());
        });
}

// 显示设备详情面板（在设备卡片上显示）
function showDeviceModal(device) {
    const deviceUDID = getDeviceApiUdid(device);
    const deviceId = getDeviceId(device);
    const panelId = `device-info-panel-${safeIdFromUdid(deviceId)}`;
    
    // 检查是否在全屏模式下
    const isFullscreen = currentFullscreenDeviceUDID === deviceUDID;
    
    // 检查是否已存在
    let panel = document.getElementById(panelId);
    if (panel) {
        // 如果已存在，检查是否需要移动到正确的容器
        let currentContainer = panel.parentElement;
        let targetContainer;
        
        if (isFullscreen) {
            // 全屏模式下，应该在全屏容器内
            targetContainer = document.getElementById('focus-video-wrapper');
        } else {
            // 非全屏模式，应该在设备卡片容器内
            const wrapper = document.querySelector(`.device-card-wrapper[data-udid="${CSS.escape(deviceUDID)}"]`);
            targetContainer = wrapper ? wrapper.querySelector('.device-video-container') : null;
        }
        
        // 如果容器不匹配，需要移动面板到正确的容器
        if (targetContainer && currentContainer !== targetContainer) {
            // 确保目标容器是相对定位
            if (getComputedStyle(targetContainer).position === 'static') {
                targetContainer.style.position = 'relative';
            }
            // 移动面板到正确的容器
            targetContainer.appendChild(panel);
        }
        
        // 更新尺寸限制（根据当前容器）
        let maxWidth, maxHeight;
        if (isFullscreen) {
            maxWidth = '90%';
            maxHeight = '80vh';
        } else {
            const containerRect = targetContainer ? targetContainer.getBoundingClientRect() : { width: 400, height: 600 };
            const containerWidth = containerRect.width;
            const containerHeight = containerRect.height;
            maxWidth = Math.max(250, containerWidth * 0.9) + 'px';
            maxHeight = Math.min(containerHeight * 0.9, window.innerHeight * 0.8) + 'px';
        }
        panel.style.minWidth = isFullscreen ? '300px' : '250px';
        panel.style.maxWidth = maxWidth;
        panel.style.maxHeight = maxHeight;
        panel.style.boxSizing = 'border-box';
        
        // 切换显示/隐藏
        const isHidden = panel.style.display === 'none' || !panel.style.display;
        if (isHidden) {
            panel.style.display = 'block';
            updateDeviceInfoPanel(panel, device);
            // 更新z-index以确保在全屏模式下正确显示
            panel.style.zIndex = isFullscreen ? '3000' : '1000';
        } else {
            panel.style.display = 'none';
        }
        return;
    }
    
    let container;
    
    if (isFullscreen) {
        // 全屏模式下，显示在全屏容器内
        const focusVideoWrapper = document.getElementById('focus-video-wrapper');
        if (!focusVideoWrapper) {
            console.warn(`设备 ${deviceUDID}: 全屏模式下无法找到全屏视频容器`);
            return;
        }
        container = focusVideoWrapper;
        // 确保容器是相对定位
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
    } else {
        // 非全屏模式，显示在设备卡片容器内
        const wrapper = document.querySelector(`.device-card-wrapper[data-udid="${CSS.escape(deviceUDID)}"]`);
        if (!wrapper) {
            console.warn(`设备 ${deviceUDID}: 无法找到设备卡片`);
            return;
        }
        
        container = wrapper.querySelector('.device-video-container');
        if (!container) {
            console.warn(`设备 ${deviceUDID}: 无法找到视频容器`);
            return;
        }
        // 确保容器是相对定位
        container.style.position = 'relative';
    }
    
    // 创建设备信息面板
    panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'device-info-panel';
    
    // 计算容器的尺寸限制
    let maxWidth, maxHeight;
    if (isFullscreen) {
        // 全屏模式下，使用视口尺寸
        maxWidth = '90%';
        maxHeight = '80vh';
    } else {
        // 非全屏模式下，根据容器尺寸限制
        const containerRect = container.getBoundingClientRect();
        const containerWidth = containerRect.width;
        const containerHeight = containerRect.height;
        // 限制为容器尺寸的90%，但最小宽度300px
        maxWidth = Math.max(300, containerWidth * 0.9) + 'px';
        maxHeight = Math.min(containerHeight * 0.9, window.innerHeight * 0.8) + 'px';
    }
    
    // 全屏模式下居中显示在整个屏幕，非全屏模式下显示在设备窗体里（居中）
    panel.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.95);
        border: 2px solid #3498db;
        border-radius: 12px;
        padding: 20px;
        z-index: ${isFullscreen ? '3000' : '1000'};
        min-width: ${isFullscreen ? '300px' : '250px'};
        max-width: ${maxWidth};
        max-height: ${maxHeight};
        overflow-y: auto;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(10px);
        box-sizing: border-box;
    `;
    
    // 更新面板内容
    updateDeviceInfoPanel(panel, device);
    
    // 添加到容器
    container.appendChild(panel);
}

// 更新设备信息面板内容
function updateDeviceInfoPanel(panel, device) {
    const statusIcon = device.status === 'online' ? '🟢' : device.status === 'offline' ? '🔴' : '🟡';
    const statusText = getStatusText(device.status);
    
    panel.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #34495e;">
            <div style="color: #ecf0f1; font-size: 18px; font-weight: bold;">设备信息</div>
            <button class="close-info-btn" style="background: transparent; border: none; color: #ecf0f1; font-size: 24px; cursor: pointer; padding: 0; width: 24px; height: 24px; line-height: 24px; text-align: center;">×</button>
        </div>
        <div style="color: #ecf0f1; font-size: 14px; line-height: 1.8;">
            <div style="margin-bottom: 12px;">
                <span style="color: #95a5a6; margin-right: 8px;">名称:</span>
                <span style="color: #ecf0f1; font-weight: 500;">${device.name || device.udid}</span>
            </div>
            <div style="margin-bottom: 12px;">
                <span style="color: #95a5a6; margin-right: 8px;">状态:</span>
                <span style="color: #ecf0f1;">${statusIcon} ${statusText}</span>
            </div>
            <div style="margin-bottom: 12px;">
                <span style="color: #95a5a6; margin-right: 8px;">平台:</span>
                <span style="color: #ecf0f1;">Android</span>
            </div>
            <div style="margin-bottom: 12px;">
                <span style="color: #95a5a6; margin-right: 8px;">型号:</span>
                <span style="color: #ecf0f1;">${device.model || '未知'}</span>
            </div>
            <div style="margin-bottom: 12px;">
                <span style="color: #95a5a6; margin-right: 8px;">系统版本:</span>
                <span style="color: #ecf0f1;">${device.os_version || '未知'}</span>
            </div>
            <div style="margin-bottom: 12px;">
                <span style="color: #95a5a6; margin-right: 8px;">电量:</span>
                <span style="color: #ecf0f1;">${device.battery !== undefined ? device.battery + '%' : '未知'}</span>
            </div>
            <div style="margin-bottom: 12px;">
                <span style="color: #95a5a6; margin-right: 8px;">UDID:</span>
                <span style="color: #ecf0f1; font-family: monospace; font-size: 12px; word-break: break-all;">${device.udid}</span>
            </div>
            ${(device.endpoint_id != null && device.endpoint_id !== '') ? `
            <div style="margin-bottom: 12px;">
                <span style="color: #95a5a6; margin-right: 8px;">端点:</span>
                <span style="color: #ecf0f1;">${device.endpoint ? escapeHtml(device.endpoint) + ' (' + escapeHtml(device.endpoint_id) + ')' : escapeHtml(device.endpoint_id)}</span>
            </div>
            ` : ''}
        </div>
    `;
    
    // 绑定关闭按钮
    const closeBtn = panel.querySelector('.close-info-btn');
    if (closeBtn) {
        closeBtn.onclick = (e) => {
            e.stopPropagation(); // 阻止事件冒泡，防止退出全屏
            panel.style.display = 'none';
        };
    }
    
    // 阻止设备信息面板内的事件冒泡（防止触发全屏退出）
    panel.onclick = (e) => {
        e.stopPropagation();
    };
}

// WebRTC连接管理
let activeWebRTCConnections = new Map(); // deviceUDID -> {pc, video, container, dataChannel}

// 设备连接状态管理
const DeviceConnectionState = {
    DISCONNECTED: 'disconnected',  // 未连接
    CONNECTING: 'connecting',       // 连接中
    CONNECTED: 'connected'          // 已连接
};

// 设备连接状态映射
let deviceConnectionStates = new Map(); // deviceUDID -> DeviceConnectionState

// 获取正确的容器（确保使用对应设备的 video-wrapper）。调用方已传入正确容器时直接返回，避免依赖反查。
function getCorrectContainer(deviceUDID, currentContainer) {
    if (currentContainer && currentContainer.classList.contains('device-video-wrapper')) {
        return currentContainer;
    }
    const wrapper = findWrapperByApiUdid(deviceUDID);
    const deviceId = wrapper ? wrapper.dataset.deviceId : deviceUDID;
    const correctContainerId = `video-wrapper-${safeIdFromUdid(deviceId)}`;
    const correctContainer = document.getElementById(correctContainerId) || (wrapper && wrapper.querySelector('.device-video-wrapper'));
    return correctContainer || currentContainer;
}

// getStats() 里视频入站：Chrome 常见 mediaType:'video'，Safari/WebKit 常见 kind:'video'（无 mediaType）
function isInboundVideoRtpReport(stat) {
    return !!(stat && stat.type === 'inbound-rtp' &&
        (stat.mediaType === 'video' || stat.kind === 'video'));
}

// 与 index.html 中 vConsole 一致：服务端 --debug 且 ?debug=1 时多打 WebRTC 诊断日志
function isWebRtcVConsoleDebug() {
    try {
        if (!window.__MR_DEBUG_MODE__) return false;
        return new URLSearchParams(window.location.search).get('debug') === '1';
    } catch (e) {
        return false;
    }
}

function getIOSBrowserFlags() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isIOSChrome = /CriOS/.test(navigator.userAgent);
    return { isIOS, isIOSChrome };
}

function logWebRtcVerbose(...args) {
    if (isWebRtcVConsoleDebug()) {
        console.log(...args);
    }
}

function ensureRecvonlyTransceiver(pc, kind, deviceUDID) {
    try {
        const exists = pc.getTransceivers().some(t =>
            t && t.receiver && t.receiver.track && t.receiver.track.kind === kind
        );
        if (!exists) pc.addTransceiver(kind, { direction: 'recvonly' });
    } catch (e) {
        console.warn(`设备 ${deviceUDID}: addTransceiver(${kind}) 忽略异常:`, e);
    }
}

const IOS_PLAY_BUTTON_TEXT = '点击开始投屏画面';
const IOS_PLAY_BUTTON_STYLE = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 15px 25px; font-size: 16px; z-index: 1000; background: rgba(0,0,0,0.9); color: white; border: 2px solid white; border-radius: 8px; cursor: pointer; font-weight: bold;';

function createIosManualPlayButton(deviceUDID, video) {
    const playButton = document.createElement('button');
    playButton.className = 'ios-play-button';
    playButton.textContent = IOS_PLAY_BUTTON_TEXT;
    playButton.style.cssText = IOS_PLAY_BUTTON_STYLE;
    playButton.onclick = (e) => {
        e.stopPropagation();
        console.log(`设备 ${deviceUDID}: 用户点击播放按钮`);
        video.play().then(() => {
            console.log(`设备 ${deviceUDID}: 手动播放成功`);
            playButton.remove();
        }).catch(playErr => {
            console.error(`设备 ${deviceUDID}: 手动播放失败:`, playErr);
            playButton.textContent = '播放失败，请刷新页面';
        });
    };
    return playButton;
}

function attemptAutoPlayWithRecovery({ video, targetContainer, deviceUDID, isIOS, isIOSChrome, shouldTryImmediately }) {
    const tryPlayVideo = () => {
        if (!video.srcObject) {
            console.log(`设备 ${deviceUDID}: 视频流未设置，跳过播放`);
            return; // 还没有设置srcObject
        }

        console.log(`设备 ${deviceUDID}: 尝试播放视频，readyState: ${video.readyState}, paused: ${video.paused}, srcObject: ${!!video.srcObject}, Chrome: ${isIOSChrome}`);

        video.play().then(() => {
            console.log(`设备 ${deviceUDID}: ✓ 视频播放成功`);
        }).catch(err => {
            console.error(`设备 ${deviceUDID} ❌ 自动播放失败:`, err);
            console.error(`设备 ${deviceUDID}: 错误详情 - name: ${err.name}, message: ${err.message}`);

            // 如果自动播放失败，显示播放按钮提示用户点击
            if (err.name === 'NotAllowedError' || err.name === 'NotSupportedError' || (isIOS && err)) {
                if (!targetContainer.querySelector('.ios-play-button')) {
                    const playButton = createIosManualPlayButton(deviceUDID, video);
                    targetContainer.appendChild(playButton);
                }
            }
        });
    };

    // 立即尝试播放（如果不是iOS，或者iOS但已经设置了srcObject）
    if (shouldTryImmediately) {
        tryPlayVideo();
    }

    // iOS可能需要等待loadedmetadata事件（包括Chrome）
    if (isIOS) {
        const onLoadedMetadata = () => {
            console.log(`设备 ${deviceUDID}: iOS loadedmetadata事件触发 (Chrome: ${isIOSChrome})`);
            tryPlayVideo();
        };

        if (video.readyState >= 1) {
            onLoadedMetadata();
        } else {
            video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
        }

        // iOS Chrome可能需要更长的延迟
        if (isIOSChrome) {
            setTimeout(() => {
                if (video.srcObject && video.paused) {
                    console.log(`设备 ${deviceUDID}: iOS Chrome延迟播放尝试`);
                    tryPlayVideo();
                }
            }, 1500);
        }
    }
}

function startWebRtcStatusMonitor(deviceUDID) {
    let lastStats = {
        framesReceived: 0,
        framesDropped: 0,
        packetsLost: 0,
        packetsReceived: 0,
        bytesReceived: 0,
        framesDecoded: 0,
        keyFramesDecoded: 0,
        keyFramesReceived: 0
    };
    const connectionStartTime = Date.now();
    let hasReportedVideoStatsWarning = false;
    let lastWebRtcDebugPrintTs = 0;

    let intervalId = null;
    intervalId = setInterval(() => {
        if (!activeWebRTCConnections.has(deviceUDID)) {
            if (intervalId) clearInterval(intervalId);
            return;
        }

        const conn = activeWebRTCConnections.get(deviceUDID);
        if (conn && conn.pc) {
            const state = conn.pc.connectionState;
            const iceState = conn.pc.iceConnectionState;

            conn.pc.getStats().then(report => {
                let hasVideoStats = false;
                report.forEach(stat => {
                    if (isInboundVideoRtpReport(stat)) {
                        hasVideoStats = true;
                        const framesReceived = stat.framesReceived || 0;
                        const framesDropped = stat.framesDropped || 0;
                        const packetsLost = stat.packetsLost || 0;
                        const packetsReceived = stat.packetsReceived || 0;
                        const bytesReceived = stat.bytesReceived || 0;
                        const framesDecoded = stat.framesDecoded || 0;
                        const keyFramesDecoded = stat.keyFramesDecoded || 0;
                        const keyFramesReceived = stat.keyFramesReceived || 0;

                        const framesDelta = framesReceived - lastStats.framesReceived;
                        const framesDroppedDelta = framesDropped - lastStats.framesDropped;
                        const packetsLostDelta = packetsLost - lastStats.packetsLost;
                        const packetsReceivedDelta = packetsReceived - lastStats.packetsReceived;
                        const bytesReceivedDelta = bytesReceived - lastStats.bytesReceived;
                        const framesDecodedDelta = framesDecoded - lastStats.framesDecoded;
                        const keyFramesDecodedDelta = keyFramesDecoded - lastStats.keyFramesDecoded;
                        const keyFramesReceivedDelta = keyFramesReceived - lastStats.keyFramesReceived;

                        if (framesDroppedDelta > 10) {
                            console.warn(`设备 ${deviceUDID} ⚠️ 检测到大量丢帧: +${framesDroppedDelta}`);
                        }
                        if (packetsLostDelta > 50) {
                            console.warn(`设备 ${deviceUDID} ⚠️ 检测到大量丢包: +${packetsLostDelta}`);
                        }

                        lastStats = {
                            framesReceived,
                            framesDropped,
                            packetsLost,
                            packetsReceived,
                            bytesReceived,
                            framesDecoded,
                            keyFramesDecoded,
                            keyFramesReceived
                        };
                    }
                });

                if (isWebRtcVConsoleDebug()) {
                    const now = Date.now();
                    if (now - lastWebRtcDebugPrintTs >= 2000) {
                        lastWebRtcDebugPrintTs = now;
                        let vIn = null;
                        report.forEach(stat => {
                            if (isInboundVideoRtpReport(stat)) vIn = stat;
                        });
                        if (vIn) {
                            console.log(`[WebRTC调试] ${deviceUDID} inbound-rtp(video) bytesReceived=${vIn.bytesReceived ?? 0} framesReceived=${vIn.framesReceived ?? 0} framesDecoded=${vIn.framesDecoded ?? 0} packetsReceived=${vIn.packetsReceived ?? 0}`);
                        } else {
                            const types = new Set();
                            let anyInbound = null;
                            report.forEach(s => {
                                types.add(s.type);
                                if (s.type === 'inbound-rtp' && !anyInbound) anyInbound = s;
                            });
                            const hint = anyInbound
                                ? ` 任一条inbound-rtp: kind=${anyInbound.kind} mediaType=${anyInbound.mediaType}`
                                : '';
                            console.log(`[WebRTC调试] ${deviceUDID} 未匹配到视频inbound-rtp pc=${state} ice=${iceState} types=${[...types].join(',')}${hint}`);
                        }
                    }
                }

                if (!hasVideoStats && !hasReportedVideoStatsWarning) {
                    const elapsed = Date.now() - connectionStartTime;
                    if (elapsed > 5000 && (state === 'connected' || iceState === 'connected')) {
                        console.warn(`设备 ${deviceUDID} ⚠️ 未找到视频接收统计信息（连接已建立 ${Math.round(elapsed / 1000)} 秒）`);
                        hasReportedVideoStatsWarning = true;
                    }
                }
            }).catch(err => {
                console.error(`设备 ${deviceUDID} ❌ 获取WebRTC统计失败:`, err);
            });

            if (state === 'closed' || state === 'failed' || iceState === 'disconnected' || iceState === 'failed') {
                console.warn(`设备 ${deviceUDID} ⚠️ 检测到WebRTC连接问题，状态: ${state}, ICE: ${iceState}`);
            }
        }
    }, 1000);
    return intervalId;
}

function parseTurnServerConfig(turnUrl) {
    try {
        let cleanUrl = turnUrl;
        let username = null;
        let credential = null;

        if (turnUrl.includes('?')) {
            // 使用 http: 前缀来解析URL（因为 turn: 不是标准协议）
            const urlObj = new URL(turnUrl.replace(/^turn:/, 'http:'));
            username = urlObj.searchParams.get('username');
            credential = urlObj.searchParams.get('credential');
            cleanUrl = `turn:${urlObj.hostname}:${urlObj.port || 3478}`;
        }

        const server = { urls: cleanUrl };
        if (username) server.username = username;
        if (credential) server.credential = credential;
        return server;
    } catch (e) {
        console.warn(`[ICE] 解析TURN URL失败: ${turnUrl}`, e);
        return { urls: turnUrl.split('?')[0] };
    }
}

async function fetchIceServers() {
    const defaultIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
        const iceResponse = await fetch('/api/webrtc/ice-servers');
        console.log(`[ICE] 请求ICE服务器配置，状态: ${iceResponse.status}`);
        if (!iceResponse.ok) {
            const errorText = await iceResponse.text();
            console.warn(`[ICE] 获取ICE服务器配置失败 (${iceResponse.status}):`, errorText);
            return defaultIceServers;
        }

        const iceConfig = await iceResponse.json();
        console.log(`[ICE] 收到ICE服务器配置:`, iceConfig);
        const iceServers = [];

        if (Array.isArray(iceConfig.stun) && iceConfig.stun.length > 0) {
            iceConfig.stun.forEach(stunUrl => {
                iceServers.push({ urls: stunUrl });
            });
            console.log(`[ICE] 添加了 ${iceConfig.stun.length} 个STUN服务器`);
        }

        if (Array.isArray(iceConfig.turn) && iceConfig.turn.length > 0) {
            iceConfig.turn.forEach(turnUrl => {
                const server = parseTurnServerConfig(turnUrl);
                iceServers.push(server);
                console.log(`[ICE] 添加TURN服务器: ${server.urls}${server.username ? ` (用户名: ${server.username})` : ''}`);
            });
            console.log(`[ICE] 添加了 ${iceConfig.turn.length} 个TURN服务器`);
        }

        if (iceServers.length === 0) {
            console.warn('[ICE] 未获取到ICE服务器配置，使用默认STUN');
            return defaultIceServers;
        }
        console.log(`[ICE] 总共配置了 ${iceServers.length} 个ICE服务器`);
        return iceServers;
    } catch (error) {
        console.error('[ICE] 获取ICE服务器配置出错:', error);
        return defaultIceServers;
    }
}

function bindVideoPlaybackEvents(video, deviceUDID, targetContainer) {
    // 监听视频播放状态变化
    video.addEventListener('play', () => {
        logWebRtcVerbose(`设备 ${deviceUDID}: 视频开始播放`);
    });

    video.addEventListener('pause', () => {
        logWebRtcVerbose(`设备 ${deviceUDID}: 视频暂停`);
    });

    video.addEventListener('waiting', () => {
        logWebRtcVerbose(`设备 ${deviceUDID}: 视频等待数据`);
    });

    video.addEventListener('canplay', () => {
        logWebRtcVerbose(`设备 ${deviceUDID}: 视频可以播放`);
    });

    // 监听视频错误事件
    video.addEventListener('error', (e) => {
        console.error(`设备 ${deviceUDID}: 视频元素错误:`, e);
        const error = video.error;
        if (error) {
            console.error(`设备 ${deviceUDID}: 视频错误代码: ${error.code}, 消息: ${error.message}`);
            // MEDIA_ERR_SRC_NOT_SUPPORTED = 4
            if (error.code === 4) {
                const errorMsg = document.createElement('div');
                errorMsg.className = 'error-state';
                errorMsg.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 20px; background: rgba(231, 76, 60, 0.9); color: white; border-radius: 8px; z-index: 1000; text-align: center;';
                errorMsg.innerHTML = `
                    <p style="font-size: 16px; font-weight: bold; margin-bottom: 10px;">❌ 视频格式不支持</p>
                    <p style="font-size: 14px;">您的设备可能不支持H.264编码</p>
                    <p style="font-size: 12px; margin-top: 10px; opacity: 0.9;">需要 iOS 14.5+ 才能观看视频</p>
                `;
                targetContainer.appendChild(errorMsg);
            }
        }
    });
}

function createClientControlDataChannel(pc, deviceUDID) {
    // 在创建Offer之前创建DataChannel，这样Offer的SDP中会包含m=application
    // 这样服务器端的Answer中也会包含DataChannel信息
    console.log(`设备 ${deviceUDID}: 在创建Offer之前创建DataChannel...`);
    const clientDataChannel = pc.createDataChannel('client-control', {
        ordered: true
    });

    // 保存客户端创建的DataChannel（虽然我们主要使用服务器端创建的）
    clientDataChannel.onopen = () => {
        // 客户端DataChannel已打开
    };
    clientDataChannel.onclose = () => {
        // 客户端DataChannel已关闭
    };
    clientDataChannel.onerror = (error) => {
        console.error(`设备 ${deviceUDID}: 客户端DataChannel错误:`, error);
    };

    return clientDataChannel;
}

function checkH264Support(deviceUDID) {
    const { isIOS } = getIOSBrowserFlags();
    let h264Supported = true;

    // iOS版本检测（简化版，通过User-Agent判断）
    if (isIOS) {
        const iosVersionMatch = navigator.userAgent.match(/OS (\d+)_(\d+)/);
        if (iosVersionMatch) {
            const majorVersion = parseInt(iosVersionMatch[1]);
            const minorVersion = parseInt(iosVersionMatch[2]);
            // iOS 14.5+ 才支持 H.264
            if (majorVersion < 14 || (majorVersion === 14 && minorVersion < 5)) {
                h264Supported = false;
                console.warn(`设备 ${deviceUDID}: iOS版本 ${majorVersion}.${minorVersion} 不支持H.264编码，需要iOS 14.5+`);
            }
        }
    }

    // 检查RTCRtpReceiver的编码能力（如果支持）
    if (typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities) {
        try {
            const capabilities = RTCRtpReceiver.getCapabilities('video');
            if (capabilities && capabilities.codecs) {
                const h264Codec = capabilities.codecs.find(codec =>
                    codec.mimeType === 'video/H264' || codec.mimeType === 'video/h264'
                );
                if (!h264Codec) {
                    h264Supported = false;
                    console.warn(`设备 ${deviceUDID}: 浏览器不支持H.264编码`);
                } else {
                    console.log(`设备 ${deviceUDID}: 浏览器支持H.264编码:`, h264Codec.mimeType);
                }
            }
        } catch (e) {
            console.warn(`设备 ${deviceUDID}: 无法检测编码能力:`, e);
        }
    }

    // 如果不支持H.264，记录警告但继续连接（控制功能可能仍然可用）
    if (!h264Supported) {
        console.warn(`设备 ${deviceUDID}: ⚠️ iOS版本不支持H.264，视频可能无法显示，但控制功能可能仍然可用`);
    }
    return h264Supported;
}

function bindPeerConnectionLifecycleEvents(pc, deviceUDID) {
    // 处理连接状态变化
    pc.onconnectionstatechange = () => {
        // 检查连接是否还在Map中（可能已被清理）
        if (!activeWebRTCConnections.has(deviceUDID)) {
            return; // 已被清理，不再处理
        }

        const state = pc.connectionState;
        if (state === 'closed' || state === 'failed') {
            console.error(`设备 ${deviceUDID} ⚠️ WebRTC连接已关闭/失败，清理资源...`);
            if (activeWebRTCConnections.has(deviceUDID)) {
                cleanupWebRTCConnection(deviceUDID);
            }
        } else if (state === 'disconnected') {
            // 与后端一致：Disconnected 常可恢复，不把整页标成已断开（避免多路/弱网误伤）
            console.warn(`设备 ${deviceUDID} ⚠️ WebRTC connectionState=disconnected（可能恢复，等待 closed/failed）`);
        } else if (state === 'connected') {
            console.log(`设备 ${deviceUDID} ✓ WebRTC连接已建立`);
            // 注意：连接状态在DataChannel打开时设置为已连接，这里不设置
        }
    };

    // 处理ICE连接状态变化
    pc.oniceconnectionstatechange = () => {
        if (!activeWebRTCConnections.has(deviceUDID)) {
            return; // 已被清理，不再处理
        }

        const iceState = pc.iceConnectionState;
        if (iceState === 'failed') {
            console.error(`设备 ${deviceUDID} ⚠️ ICE连接失败，清理资源...`);
            if (activeWebRTCConnections.has(deviceUDID)) {
                cleanupWebRTCConnection(deviceUDID);
            }
        } else if (iceState === 'disconnected') {
            console.warn(`设备 ${deviceUDID} ⚠️ ICE连接已断开`);
        } else if (iceState === 'closed') {
            console.log(`设备 ${deviceUDID} ICE连接已关闭`);
        }
    };

    // 处理ICE候选错误
    pc.onicecandidateerror = (event) => {
        console.error(`设备 ${deviceUDID} ICE候选错误:`, event);
    };

    // 处理ICE收集完成（不输出日志）
    pc.onicegatheringstatechange = () => {
        // ICE收集状态变化（静默处理）
    };
}

function handleIncomingVideoTrack({
    track,
    conn,
    combinedStream,
    targetContainer,
    container,
    video,
    deviceUDID,
}) {
    console.log(`设备 ${deviceUDID}: 收到视频轨道，readyState: ${track.readyState}, enabled: ${track.enabled}, muted: ${track.muted}`);

    // 检查视频轨道的编码格式
    let codecInfo = '未知';
    if (track.getSettings) {
        try {
            const settings = track.getSettings();
            console.log(`设备 ${deviceUDID}: 视频轨道设置:`, settings);
            if (settings.codec) {
                codecInfo = settings.codec;
            }
        } catch (e) {
            console.warn(`设备 ${deviceUDID}: 无法获取视频轨道设置:`, e);
        }
    }
    if (track.getCapabilities) {
        try {
            const capabilities = track.getCapabilities();
            console.log(`设备 ${deviceUDID}: 视频轨道能力:`, capabilities);
        } catch (e) {
            // 忽略错误
        }
    }
    if (track.getParameters) {
        try {
            const params = track.getParameters();
            console.log(`设备 ${deviceUDID}: 视频轨道参数:`, params);
            if (params.codecs && params.codecs.length > 0) {
                codecInfo = params.codecs[0].mimeType || codecInfo;
                console.log(`设备 ${deviceUDID}: 检测到编码格式: ${codecInfo}`);
            }
        } catch (e) {
            // 忽略错误
        }
    }

    const { isIOS } = getIOSBrowserFlags();
    if (isIOS && codecInfo.includes('H264')) {
        const iosVersionMatch = navigator.userAgent.match(/OS (\d+)_(\d+)/);
        if (iosVersionMatch) {
            const majorVersion = parseInt(iosVersionMatch[1]);
            const minorVersion = parseInt(iosVersionMatch[2]);
            if (majorVersion < 14 || (majorVersion === 14 && minorVersion < 5)) {
                console.error(`设备 ${deviceUDID}: ❌ iOS ${majorVersion}.${minorVersion} 不支持H.264 WebRTC编码`);
                setTimeout(() => {
                    if (video.error && video.error.code === 4) {
                        const errorMsg = document.createElement('div');
                        errorMsg.className = 'error-state';
                        errorMsg.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 20px; background: rgba(231, 76, 60, 0.95); color: white; border-radius: 8px; z-index: 1000; text-align: center; max-width: 90%;';
                        errorMsg.innerHTML = `
                            <p style="font-size: 16px; font-weight: bold; margin-bottom: 10px;">❌ 视频格式不支持</p>
                            <p style="font-size: 14px; margin-bottom: 10px;">您的iOS版本 (${majorVersion}.${minorVersion}) 不支持H.264编码</p>
                            <p style="font-size: 12px; margin-top: 10px; opacity: 0.9;">需要 iOS 14.5 或更高版本才能观看视频流</p>
                            <p style="font-size: 11px; margin-top: 8px; opacity: 0.8;">控制功能仍然可用</p>
                        `;
                        targetContainer.appendChild(errorMsg);
                    }
                }, 2000);
            }
        }
    }

    // 只在第一次收到视频轨道时设置（后续音频轨道添加到combinedStream会自动包含，无需重新设置）
    if (!conn.videoStreamSet) {
        if (!targetContainer.contains(video)) {
            console.log(`设备 ${deviceUDID}: video元素未在容器中，添加到容器`);
            targetContainer.innerHTML = '';
            targetContainer.appendChild(video);
        }

        const videoRect = video.getBoundingClientRect();
        const containerRect = targetContainer.getBoundingClientRect();
        console.log(`设备 ${deviceUDID}: video元素尺寸: ${videoRect.width}x${videoRect.height}, 容器尺寸: ${containerRect.width}x${containerRect.height}`);

        console.log(`设备 ${deviceUDID}: 设置视频流到video元素`);
        console.log(`设备 ${deviceUDID}: combinedStream tracks数量: ${combinedStream.getTracks().length}`);
        combinedStream.getTracks().forEach(t => {
            console.log(`设备 ${deviceUDID}: 轨道类型: ${t.kind}, enabled: ${t.enabled}, muted: ${t.muted}, readyState: ${t.readyState}`);
        });

        video.srcObject = combinedStream;
        conn.videoStreamSet = true;
        syncAudioToggleButtons(deviceUDID, !video.muted); // 按真实静音状态同步按钮，避免图标与实际出声不一致
        const audioTracksInStream = combinedStream.getAudioTracks().length;
        console.log(`设备 ${deviceUDID}: video.srcObject 已设置, 音频轨数=${audioTracksInStream}, video.muted=${video.muted}`);

        if (video) {
            video.style.transform = '';
        }

        const correctVideoWrapper = container.querySelector('.device-video-wrapper') || targetContainer;
        setupVideoClickHandler(deviceUDID, correctVideoWrapper);

        activeWebRTCConnections.set(deviceUDID, conn);

        setTimeout(() => {
            console.log(`设备 ${deviceUDID}: video元素状态检查 - readyState: ${video.readyState}, videoWidth: ${video.videoWidth}, videoHeight: ${video.videoHeight}, paused: ${video.paused}`);
            if (video.videoWidth === 0 || video.videoHeight === 0) {
                console.warn(`设备 ${deviceUDID}: ⚠️ video元素尺寸为0，可能没有视频数据`);
            }
        }, 500);
    } else {
        console.log(`设备 ${deviceUDID}: 视频流已设置，跳过重复设置`);
    }
}

// 初始化WebRTC流
async function initWebRTCStream(deviceUDID, container) {
    // 确保使用正确的容器
    container = getCorrectContainer(deviceUDID, container);
    // 如果已有连接，先清理
    if (activeWebRTCConnections.has(deviceUDID)) {
        console.log(`清理设备 ${deviceUDID} 的旧连接...`);
        cleanupWebRTCConnection(deviceUDID);
    }
    
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true; // 移动端内联播放
    // video.muted = true; // iOS 实测：先注掉默认静音，验证是否可直接有声播放
    // iOS Safari需要设置webkit-playsinline属性（旧版Safari）
    video.setAttribute('webkit-playsinline', 'true');
    video.setAttribute('playsinline', 'true');
    video.controls = false; // 实时 WebRTC 流不要用原生控件：时长多为 0、易误判为「视频坏了」
    // 对于实时流，不显示controls，因为duration不准确
    // 使用auto让视频自适应，保持比例（和专注模式一致）
    video.style.width = 'auto';
    video.style.height = 'auto';
    video.style.maxWidth = '100%';
    video.style.maxHeight = '100%';
    video.style.objectFit = 'contain';
    video.style.backgroundColor = '#000';
    video.style.display = 'block';
    
    // iOS Safari要求video元素必须在设置srcObject之前就添加到DOM
    // 立即将video元素添加到容器中
    let videoWrapper = container.querySelector('.device-video-wrapper') || container;
    videoWrapper.innerHTML = ''; // 清空容器
    videoWrapper.appendChild(video);
    console.log(`设备 ${deviceUDID}: video元素已添加到DOM`);

    let colorCorrectStop = null;
    if (shouldEnableVideoColorCorrectRB()) {
        colorCorrectStop = createVideoColorCorrectRB(video, videoWrapper);
        if (colorCorrectStop) console.log(`设备 ${deviceUDID}: 已启用投屏颜色校正(R/B交换)`);
    }

    // 添加点击事件监听器
    setupVideoClickHandler(deviceUDID, videoWrapper);
    
    // 检测是否为 iOS / iOS Chrome（CriOS）
    const { isIOS, isIOSChrome } = getIOSBrowserFlags();
    console.log(`设备 ${deviceUDID}: 浏览器检测 - iOS: ${isIOS}, iOS Chrome: ${isIOSChrome}`);
    
    // 添加播放事件监听
    video.addEventListener('loadedmetadata', () => {
        // 视频元数据已加载，iOS需要在这里尝试播放
        if (isIOS && video.srcObject) {
            console.log(`设备 ${deviceUDID}: loadedmetadata事件触发，尝试播放 (Chrome: ${isIOSChrome})`);
            video.play().then(() => {
                console.log(`设备 ${deviceUDID}: loadedmetadata后播放成功`);
            }).catch(err => {
                console.warn(`设备 ${deviceUDID}: iOS视频元数据加载后播放失败:`, err);
            });
        }
    });
    
    video.addEventListener('playing', () => {
        // 视频开始播放（静默处理）
    });
    
    // 对于实时流，不应该暂停。如果触发了pause事件，立即恢复
    let pauseRecoveryAttempts = 0;
    const MAX_PAUSE_RECOVERY_ATTEMPTS = 5;
    
    video.addEventListener('pause', (e) => {
        // 记录暂停信息以便调试
        const isPageVisible = !document.hidden;
        const hasSource = video.srcObject !== null;
        const tracks = video.srcObject ? video.srcObject.getTracks() : [];
        const trackStates = tracks.map(t => `${t.readyState}/${t.enabled}`).join(',');
        
        // 获取调用栈，看是谁触发的暂停
        const stack = new Error().stack;
        const stackLines = stack ? stack.split('\n').slice(2, 8).join('\n') : '无法获取调用栈';
        
        // 检查视频元素是否还在DOM中
        const isInDOM = document.body.contains(video);
        const container = video.parentElement;
        const containerId = container ? container.id : '无容器';
        
        // 检查WebRTC连接状态
        const conn = activeWebRTCConnections.get(deviceUDID);
        const pcState = conn && conn.pc ? `${conn.pc.connectionState}/${conn.pc.iceConnectionState}` : '无连接';
        
        console.warn(`设备 ${deviceUDID}: ⚠️ 视频暂停事件触发`);
        console.warn(`  - 页面可见: ${isPageVisible}`);
        console.warn(`  - 有源: ${hasSource}`);
        console.warn(`  - 轨道状态: [${trackStates}]`);
        console.warn(`  - 在DOM中: ${isInDOM}`);
        console.warn(`  - 容器ID: ${containerId}`);
        console.warn(`  - WebRTC状态: ${pcState}`);
        console.warn(`  - 恢复尝试: ${pauseRecoveryAttempts}`);
        console.warn(`  - 调用栈:\n${stackLines}`);
        
        // 对于实时流，如果页面可见且有源，立即恢复播放
        if (video.srcObject && video.paused && isPageVisible && !document.hidden && pauseRecoveryAttempts < MAX_PAUSE_RECOVERY_ATTEMPTS) {
            pauseRecoveryAttempts++;
            // 立即尝试恢复，不使用 requestAnimationFrame，避免延迟
            const playPromise = video.play();
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    console.log(`设备 ${deviceUDID}: ✓ 已自动恢复播放 (尝试 ${pauseRecoveryAttempts})`);
                    pauseRecoveryAttempts = 0; // 成功后重置计数器
                }).catch(err => {
                    console.error(`设备 ${deviceUDID}: ❌ 恢复播放失败 (尝试 ${pauseRecoveryAttempts}):`, err);
                    // 如果失败，延迟重试
                    if (pauseRecoveryAttempts < MAX_PAUSE_RECOVERY_ATTEMPTS) {
                        setTimeout(() => {
                            if (video.paused && video.srcObject && !document.hidden) {
                                video.play().then(() => {
                                    console.log(`设备 ${deviceUDID}: ✓ 延迟恢复播放成功`);
                                    pauseRecoveryAttempts = 0;
                                }).catch(e => {
                                    console.error(`设备 ${deviceUDID}: ❌ 延迟恢复播放也失败:`, e);
                                });
                            }
                        }, 100);
                    }
                });
            }
        } else if (pauseRecoveryAttempts >= MAX_PAUSE_RECOVERY_ATTEMPTS) {
            console.error(`设备 ${deviceUDID}: ❌ 已达到最大恢复尝试次数 (${MAX_PAUSE_RECOVERY_ATTEMPTS})，停止自动恢复`);
        }
    });
    
    // 播放成功时重置计数器
    video.addEventListener('playing', () => {
        if (pauseRecoveryAttempts > 0) {
            pauseRecoveryAttempts = 0;
        }
    });
    
    video.addEventListener('error', (e) => {
        console.error(`设备 ${deviceUDID} ❌ 视频播放错误:`, e, video.error);
        if (video.error) {
            const errorCode = video.error.code;
            const errorMessage = video.error.message;
            console.error(`设备 ${deviceUDID} ❌ 错误详情 - 代码: ${errorCode}, 消息: ${errorMessage}`);
            
            // 错误代码说明
            const errorCodes = {
                1: 'MEDIA_ERR_ABORTED - 用户中止',
                2: 'MEDIA_ERR_NETWORK - 网络错误',
                3: 'MEDIA_ERR_DECODE - 解码错误',
                4: 'MEDIA_ERR_SRC_NOT_SUPPORTED - 格式不支持'
            };
            if (errorCodes[errorCode]) {
                console.error(`设备 ${deviceUDID} ❌ 错误说明: ${errorCodes[errorCode]}`);
            }
            
            // 如果是解码错误，可能是H.264格式问题
            if (errorCode === 3) {
                console.error(`设备 ${deviceUDID} ❌ 可能是H.264解码失败，检查SPS/PPS配置`);
            }
        }
    });
    
    video.addEventListener('ended', () => {
        console.warn(`设备 ${deviceUDID}: 视频播放结束（可能是流断开）`);
        // 对于实时流，ended不应该发生，尝试重新播放
        if (video.srcObject) {
            video.play().catch(err => {
                console.error(`设备 ${deviceUDID}: 播放结束后重新播放失败:`, err);
            });
        }
    });
    
    video.addEventListener('stalled', () => {
        console.warn(`设备 ${deviceUDID} ⚠️ 视频播放停滞（可能没有数据）`);
        // 检查WebRTC连接状态
        const conn = activeWebRTCConnections.get(deviceUDID);
        if (conn && conn.pc) {
            console.warn(`设备 ${deviceUDID} ⚠️ WebRTC状态: ${conn.pc.connectionState}, ICE: ${conn.pc.iceConnectionState}`);
            if (video.srcObject) {
                const tracks = video.srcObject.getTracks();
                tracks.forEach(track => {
                    console.warn(`设备 ${deviceUDID} ⚠️ 轨道状态: ${track.readyState}`);
                });
            }
        }
    });
    
    video.addEventListener('waiting', () => {
        console.warn(`设备 ${deviceUDID} ⚠️ 视频等待数据...`);
        // 检查是否有数据接收
        const conn = activeWebRTCConnections.get(deviceUDID);
        if (conn && conn.pc) {
            const stats = conn.pc.getStats();
            stats.then(report => {
                report.forEach(stat => {
                    if (isInboundVideoRtpReport(stat)) {
                        console.warn(`设备 ${deviceUDID} ⚠️ 接收统计 - 帧数: ${stat.framesReceived || 0}, 丢帧: ${stat.framesDropped || 0}, 字节: ${stat.bytesReceived || 0}`);
                    }
                });
            }).catch(err => {
                console.error(`设备 ${deviceUDID} ❌ 获取统计信息失败:`, err);
            });
        }
    });
    
    video.addEventListener('canplay', () => {
        // 视频可以播放（静默处理）
    });
    
    video.addEventListener('canplaythrough', () => {
        // 视频可以流畅播放（静默处理）
    });
    
    
    const deviceIdForDom = getDeviceIdForApiUdid(deviceUDID);
    const expectedContainerId = `video-wrapper-${safeIdFromUdid(deviceIdForDom)}`;
    if (container.id !== expectedContainerId) {
        console.warn(`设备 ${deviceUDID}: 容器ID不匹配，期望: ${expectedContainerId}, 实际: ${container.id}`);
        const correctContainer = document.getElementById(expectedContainerId);
        if (correctContainer) {
            // 找到正确的容器，使用它
            container = correctContainer;
            // 更新videoWrapper引用（复用第687行定义的变量）
            const newVideoWrapper = container.querySelector('.device-video-wrapper') || container;
            if (newVideoWrapper !== videoWrapper) {
                // 如果容器改变了，需要更新video元素的位置
                if (video.parentElement === videoWrapper) {
                    videoWrapper.removeChild(video);
                }
                newVideoWrapper.appendChild(video);
                videoWrapper = newVideoWrapper; // 更新引用
            }
        }
    }
    
    // 确保容器有正确的样式
    container.style.position = 'relative';
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    
    try {
        // 从服务器获取ICE服务器配置
        const iceServers = await fetchIceServers();
        
        // 创建RTCPeerConnection（允许使用STUN和TURN，优先直连以减少延迟）
        const pc = new RTCPeerConnection({
            iceServers: iceServers,
            iceTransportPolicy: 'all' // 允许使用STUN和TURN，优先直连
        });
        
        // 周期状态监控（统计/弱网/调试日志）
        const statusCheckInterval = startWebRtcStatusMonitor(deviceUDID);
        
        // 确保container是正确的（对应设备的video-wrapper）
        const finalContainer = getCorrectContainer(deviceUDID, container);
        
        // 如果video不在正确容器中，移动它（不清空容器，直接移动元素）
        if (!finalContainer.contains(video)) {
            // 移动video元素到正确的容器
            // 先移除video元素（如果它在其他容器中）
            if (video.parentElement) {
                video.parentElement.removeChild(video);
            }
            // 清空目标容器（但保留其他元素，如果有的话）
            // 注意：这里只清空是为了确保video是唯一子元素，但会触发暂停
            // 所以先保存播放状态
            const wasPlaying = !video.paused;
            const currentTime = video.currentTime;
            finalContainer.innerHTML = '';
            finalContainer.appendChild(video);
            // 如果之前在播放，恢复播放
            if (wasPlaying && video.srcObject) {
                video.play().catch(err => {
                    console.error(`设备 ${deviceUDID}: 移动后恢复播放失败:`, err);
                });
            }
        }
        
        activeWebRTCConnections.set(deviceUDID, { pc, video, container: finalContainer, dataChannel: null, statusCheckInterval, combinedStream: null, videoStreamSet: false, colorCorrectStop });
        // 已保存连接信息
        
        bindPeerConnectionLifecycleEvents(pc, deviceUDID);
        
        // 处理数据通道（后端会创建名为"control"的DataChannel）
        // 注意：必须在创建 PeerConnection 之后、设置远程描述之前设置这个监听器
        pc.ondatachannel = (event) => {
            const channel = event.channel;
            
            if (channel.label === 'control') {
                
                // 立即保存 DataChannel 到连接信息（不等待 onopen）
                const conn = activeWebRTCConnections.get(deviceUDID);
                if (conn) {
                    conn.dataChannel = channel;
                    activeWebRTCConnections.set(deviceUDID, conn);
                    console.log(`设备 ${deviceUDID}: ✓ DataChannel已保存到连接信息`);
                } else {
                    console.warn(`设备 ${deviceUDID}: ⚠️ 未找到连接信息，无法保存DataChannel`);
                }
                
                channel.onopen = () => {
                    // DataChannel已打开
                    // 再次确认连接信息（确保状态同步）
                    const conn = activeWebRTCConnections.get(deviceUDID);
                    if (conn) {
                        conn.dataChannel = channel;
                        activeWebRTCConnections.set(deviceUDID, conn);
                    }
                    // 设置连接状态为已连接（会同步启用控制按钮）
                    setDeviceConnectionState(deviceUDID, DeviceConnectionState.CONNECTED);
                    
                    // 启动心跳机制，防止WebRTC连接因NAT/防火墙超时断开
                    // 心跳间隔：20秒（小于大多数NAT超时时间30-60秒）
                    const heartbeatInterval = setInterval(() => {
                        if (!activeWebRTCConnections.has(deviceUDID)) {
                            clearInterval(heartbeatInterval);
                            return;
                        }
                        
                        const currentConn = activeWebRTCConnections.get(deviceUDID);
                        if (!currentConn || !currentConn.dataChannel) {
                            clearInterval(heartbeatInterval);
                            return;
                        }
                        
                        // 检查DataChannel状态
                        if (currentConn.dataChannel.readyState !== 'open') {
                            console.warn(`设备 ${deviceUDID}: DataChannel状态不是open (${currentConn.dataChannel.readyState})，停止心跳`);
                            clearInterval(heartbeatInterval);
                            return;
                        }
                        
                        // 发送心跳消息（0xFF = 心跳）
                        try {
                            currentConn.dataChannel.send(new Uint8Array([0xFF]));
                            // 不输出日志，避免日志过多
                        } catch (error) {
                            console.error(`设备 ${deviceUDID}: 发送心跳失败:`, error);
                            clearInterval(heartbeatInterval);
                        }
                    }, 20000); // 20秒发送一次心跳
                    
                    // 保存心跳定时器，以便清理时停止
                    if (conn) {
                        conn.heartbeatInterval = heartbeatInterval;
                        activeWebRTCConnections.set(deviceUDID, conn);
                    }
                };
                
                channel.onclose = () => {
                    // 检查连接是否还在Map中（可能已被清理）
                    if (!activeWebRTCConnections.has(deviceUDID)) {
                        return; // 已被清理，不再处理
                    }
                    
                    console.error(`[TOUCH] 设备 ${deviceUDID}: DataChannel已关闭！readyState: ${channel.readyState}`);
                    // 清除连接信息中的 DataChannel 和心跳定时器
                    const conn = activeWebRTCConnections.get(deviceUDID);
                    if (conn) {
                        // 清理心跳定时器
                        if (conn.heartbeatInterval) {
                            clearInterval(conn.heartbeatInterval);
                            conn.heartbeatInterval = null;
                        }
                        conn.dataChannel = null;
                        activeWebRTCConnections.set(deviceUDID, conn);
                    }
                    // 统一设为未连接（会同步禁用控制按钮）
                    setDeviceConnectionState(deviceUDID, DeviceConnectionState.DISCONNECTED);
                };
                
                channel.onerror = (error) => {
                    console.error(`[TOUCH] 设备 ${deviceUDID}: DataChannel错误:`, error);
                    console.error(`[TOUCH] DataChannel错误详情 - readyState: ${channel.readyState}, bufferedAmount: ${channel.bufferedAmount}`);
                };
                
                channel.onmessage = (event) => {
                    handleDeviceMessage(deviceUDID, event.data);
                };
            } else {
                // 收到其他数据通道
            }
        };
        
        // 处理错误
        pc.onerror = (event) => {
            console.error(`设备 ${deviceUDID} WebRTC错误:`, event);
        };
        
        // 处理接收到的流
        pc.ontrack = (event) => {
            const track = event.track;
            
            // 获取连接信息
            const conn = activeWebRTCConnections.get(deviceUDID);
            if (!conn) {
                console.error(`设备 ${deviceUDID}: 未找到连接信息，无法处理轨道`);
                return;
            }
            
            // 获取或创建统一的MediaStream
            let combinedStream = conn.combinedStream;
            if (!combinedStream) {
                combinedStream = new MediaStream();
                conn.combinedStream = combinedStream;
                activeWebRTCConnections.set(deviceUDID, conn);
            }
            
            // 将轨道添加到统一的MediaStream
            combinedStream.addTrack(track);
            const trackKindLabel = track.kind === 'audio' ? '音频' : '视频';

            if (track.kind === 'audio') {
                console.log(`设备 ${deviceUDID} [音频] 收到音频轨道 id=${track.id} readyState=${track.readyState} enabled=${track.enabled} muted=${track.muted}`);
            }

            // 监听轨道状态
            track.onended = () => {
                // 检查连接是否还在Map中（可能已被清理）
                if (!activeWebRTCConnections.has(deviceUDID)) {
                    return; // 已被清理，不再处理
                }
                console.error(`设备 ${deviceUDID} ❌ ${trackKindLabel}轨道已结束`);
                if (track.kind === 'video' && activeWebRTCConnections.has(deviceUDID)) {
                    cleanupWebRTCConnection(deviceUDID);
                }
            };

            track.onmute = () => {
                console.warn(`设备 ${deviceUDID} ⚠️ ${trackKindLabel}轨道已静音`);
            };

            track.onunmute = () => {
                console.log(`设备 ${deviceUDID} ✓ ${trackKindLabel}轨道已取消静音`);
            };
            
            // 监听轨道状态变化
            let lastReadyState = track.readyState;
            const trackStateCheck = setInterval(() => {
                if (!activeWebRTCConnections.has(deviceUDID)) {
                    clearInterval(trackStateCheck);
                    return;
                }
                
                if (track.readyState !== lastReadyState) {
                    lastReadyState = track.readyState;
                    
                    if (track.readyState === 'ended') {
                        console.error(`设备 ${deviceUDID} ❌ 轨道已结束`);
                    }
                }
            }, 1000);
            
            const deviceIdForDom = getDeviceIdForApiUdid(deviceUDID);
            const correctContainerId = `video-wrapper-${safeIdFromUdid(deviceIdForDom)}`;
            let targetContainer = container;
            if (container.id !== correctContainerId) {
                const correctContainer = document.getElementById(correctContainerId);
                if (correctContainer) {
                    // 切换到正确的容器
                    targetContainer = correctContainer;
                    // 更新activeWebRTCConnections中的container引用
                    const conn = activeWebRTCConnections.get(deviceUDID);
                    if (conn) {
                        conn.container = targetContainer;
                        activeWebRTCConnections.set(deviceUDID, conn);
                    }
                }
            }
            
            // 确保video元素在正确的容器中（不清空容器，直接移动元素）
            if (!targetContainer.contains(video)) {
                console.warn(`设备 ${deviceUDID}: video元素不在容器 ${targetContainer.id} 中，重新添加`);
                // 先保存播放状态
                const wasPlaying = !video.paused;
                // 先移除video元素（如果它在其他容器中）
                if (video.parentElement) {
                    video.parentElement.removeChild(video);
                }
                // 清空目标容器并添加video
                targetContainer.innerHTML = '';
                targetContainer.appendChild(video);
                // 如果之前在播放，恢复播放
                if (wasPlaying && video.srcObject) {
                    video.play().catch(err => {
                        console.error(`设备 ${deviceUDID}: 移动后恢复播放失败:`, err);
                    });
                }
            }
            
            // 处理视频轨道：只在第一次收到视频轨道时设置srcObject
            if (track.kind === 'video') {
                handleIncomingVideoTrack({
                    track,
                    conn,
                    combinedStream,
                    targetContainer,
                    container,
                    video,
                    deviceUDID,
                });
            }
            
            // 确保容器和video的尺寸正确（containerRect已在第1403行定义，这里重新获取以获取最新尺寸）
            const currentContainerRect = targetContainer.getBoundingClientRect();
            logWebRtcVerbose(`设备 ${deviceUDID}: 容器信息 - 尺寸: ${currentContainerRect.width}x${currentContainerRect.height}, 位置: (${currentContainerRect.left}, ${currentContainerRect.top})`);
            
            if (currentContainerRect.width === 0 || currentContainerRect.height === 0) {
                console.warn(`设备 ${deviceUDID}: ⚠️ 容器尺寸为0，尝试修复...`);
                // 强制触发布局计算
                void targetContainer.offsetWidth;
                void targetContainer.offsetHeight;
                // 再次检查
                const newRect = targetContainer.getBoundingClientRect();
                console.log(`设备 ${deviceUDID}: 修复后容器尺寸: ${newRect.width}x${newRect.height}`);
            }
            
            // 确保video元素在容器中且可见
            if (!targetContainer.contains(video)) {
                console.warn(`设备 ${deviceUDID}: ⚠️ video元素不在容器中，重新添加`);
                targetContainer.innerHTML = '';
                targetContainer.appendChild(video);
            }
            
            // 检查video元素的样式
            const computedStyle = window.getComputedStyle(video);
            logWebRtcVerbose(`设备 ${deviceUDID}: video元素样式 - display: ${computedStyle.display}, visibility: ${computedStyle.visibility}, opacity: ${computedStyle.opacity}, width: ${computedStyle.width}, height: ${computedStyle.height}`);
            
            
            // 监听视频解码状态（通过video元素的事件）
            let frameCount = 0;
            let lastTime = Date.now();
            
            // 使用requestVideoFrameCallback来检测帧接收（如果支持）
            if (video.requestVideoFrameCallback) {
                const checkFrame = () => {
                    if (!activeWebRTCConnections.has(deviceUDID)) {
                        return;
                    }
                    
                    frameCount++;
                    const now = Date.now();
                    const elapsed = now - lastTime;
                    
                    // 每30帧或5秒输出一次日志（用于调试）- 已禁用以减少日志输出
                    // if (frameCount % 30 === 0 || elapsed > 5000) {
                    //     console.log(`设备 ${deviceUDID}: ✓ 收到视频帧 (${frameCount}帧, ${elapsed}ms)`);
                    //     frameCount = 0;
                    //     lastTime = now;
                    // }
                    
                    // 继续监听下一帧
                    video.requestVideoFrameCallback(checkFrame);
                };
                video.requestVideoFrameCallback(checkFrame);
                console.log(`设备 ${deviceUDID}: 已启动requestVideoFrameCallback监听`);
            } else {
                // 如果不支持requestVideoFrameCallback，使用timeupdate事件
                console.log(`设备 ${deviceUDID}: 使用timeupdate事件监听视频帧`);
                video.addEventListener('timeupdate', () => {
                    frameCount++;
                    if (frameCount % 30 === 0) {
                        console.log(`设备 ${deviceUDID}: ✓ 收到视频帧 (timeupdate, ${frameCount}帧)`);
                    }
                });
            }
            
            // 设置鼠标事件处理（scrcpy风格）
            setupVideoMouseEvents(deviceUDID, video);
            
            // 确保视频播放（iOS需要特殊处理，包括Chrome）
            attemptAutoPlayWithRecovery({
                video,
                targetContainer,
                deviceUDID,
                isIOS,
                isIOSChrome,
                shouldTryImmediately: (!isIOS || conn.videoStreamSet),
            });
            
            bindVideoPlaybackEvents(video, deviceUDID, targetContainer);
        };
        
        // 显示加载状态
        container.innerHTML = '<p>正在启动视频流服务，请稍候...</p>';
        
        const clientDataChannel = createClientControlDataChannel(pc, deviceUDID);
        
        // 检测浏览器是否支持 H.264（仅告警，不阻止连接）
        checkH264Support(deviceUDID);
        
        // Safari/iOS 对 offerToReceive* 兼容性不稳定，显式声明 recvonly transceiver 更稳
        ensureRecvonlyTransceiver(pc, 'video', deviceUDID);
        ensureRecvonlyTransceiver(pc, 'audio', deviceUDID);

        // 创建Offer（保留 offerToReceive* 作为兜底，兼容旧实现）
        const offer = await pc.createOffer({
            offerToReceiveVideo: true,
            offerToReceiveAudio: true
        });
        
        // 检查Offer SDP中是否包含DataChannel支持
        if (offer.sdp) {
            if (offer.sdp.includes('m=application')) {
                console.log(`设备 ${deviceUDID}: ✓ Offer SDP中包含DataChannel支持 (m=application)`);
            } else {
                console.warn(`设备 ${deviceUDID}: ⚠️ Offer SDP中未包含DataChannel支持 (m=application)`);
            }
        }
        
        // 设置本地描述（触发 ICE 候选收集）
        await pc.setLocalDescription(offer);

        // 先发 Offer，再发 ICE（trickle）。后端要求 sessionId，因此先缓存候选，拿到 sessionId 后再发送。
        let webrtcSessionId = null;
        const pendingLocalIceCandidates = [];
        const sendIceCandidate = (candidate) => {
            if (!candidate || !webrtcSessionId) return Promise.resolve();
            return fetch(`/api/device/${encodeURIComponent(deviceUDID)}/webrtc/ice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    candidate,
                    sessionId: webrtcSessionId,
                }),
            }).catch(err => console.error('发送ICE候选失败:', err));
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                if (!webrtcSessionId) {
                    pendingLocalIceCandidates.push(event.candidate);
                    return;
                }
                sendIceCandidate(event.candidate);
            }
        };
        
        // 发送 Offer 到服务器（带重试）；用户点击断开时立即停止重试
        // 后端会等待scrcpy-server启动完成后再返回
        let response;
        let retries = 0;
        const maxRetries = 15; // 增加重试次数，因为启动需要时间
        const retryDelay = 500; // 500ms
        const retryCheckInterval = 50; // 等待期间每 50ms 检查一次是否已请求断开

        while (retries < maxRetries) {
            if (getDeviceConnectionState(deviceUDID) !== DeviceConnectionState.CONNECTING) {
                console.log(`设备 ${deviceUDID}: 用户已断开，停止连接重试`);
                return;
            }
            try {
                response = await fetch(`/api/device/${encodeURIComponent(deviceUDID)}/webrtc/offer`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ offer: pc.localDescription || offer })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    // 检查是否返回了 ready 标志
                    if (data.ready) {
                        webrtcSessionId = data.sessionId || null;
                        if (!webrtcSessionId) {
                            throw new Error('服务器未返回sessionId');
                        }
                        const connForSid = activeWebRTCConnections.get(deviceUDID);
                        if (connForSid) {
                            connForSid.sessionId = webrtcSessionId;
                            activeWebRTCConnections.set(deviceUDID, connForSid);
                        }

                        // 补发 Offer 阶段缓存的本地 ICE 候选
                        if (pendingLocalIceCandidates.length > 0) {
                            const cachedCandidates = pendingLocalIceCandidates.splice(0, pendingLocalIceCandidates.length);
                            for (const candidate of cachedCandidates) {
                                await sendIceCandidate(candidate);
                            }
                        }

                        // 成功，退出重试循环
                        // 设置远程Answer
                        // 收到Answer，设置远程描述
                        if (data.answer && data.answer.sdp) {
                            if (!data.answer.sdp.includes('m=application')) {
                                console.warn(`设备 ${deviceUDID}: ⚠️ Answer SDP中未找到DataChannel信息 (m=application)`);
                            }
                        }
                        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                        
                        // 处理后端返回的ICE候选
                        if (data.iceCandidates && Array.isArray(data.iceCandidates)) {
                            console.log(`设备 ${deviceUDID}: 收到 ${data.iceCandidates.length} 个后端ICE候选`);
                            for (const candidate of data.iceCandidates) {
                                try {
                                    await pc.addIceCandidate(candidate);
                                    console.log(`设备 ${deviceUDID}: ✓ 已添加后端ICE候选: ${candidate.candidate || 'null'}`);
                                } catch (error) {
                                    console.warn(`设备 ${deviceUDID}: 添加后端ICE候选失败:`, error, candidate);
                                }
                            }
                        } else {
                            console.warn(`设备 ${deviceUDID}: ⚠️ 后端未返回ICE候选`);
                        }
                        
                        // 设置远程描述后，等待一小段时间检查 DataChannel
                        setTimeout(() => {
                            const conn = activeWebRTCConnections.get(deviceUDID);
                            if (conn && !conn.dataChannel) {
                                console.error(`设备 ${deviceUDID}: ❌ 设置远程描述后1秒，DataChannel仍未连接！`);
                                console.error(`设备 ${deviceUDID}: 可能的原因：`);
                                console.error(`  1. Answer SDP中没有包含DataChannel信息`);
                                console.error(`  2. ondatachannel事件没有触发`);
                                console.error(`  3. WebRTC连接状态: ${conn.pc ? conn.pc.connectionState : 'unknown'}`);
                            } else if (conn && conn.dataChannel) {
                                console.log(`设备 ${deviceUDID}: ✓ DataChannel已连接 (readyState: ${conn.dataChannel.readyState})`);
                            }
                        }, 1000);
                        
                        // 恢复视频元素显示（如果video不在容器中才移动）
                        if (!container.contains(video)) {
                            // 先保存播放状态
                            const wasPlaying = !video.paused;
                            // 先移除video元素（如果它在其他容器中）
                            if (video.parentElement) {
                                video.parentElement.removeChild(video);
                            }
                            // 复用函数开头定义的videoWrapper变量（第687行）
                            videoWrapper.innerHTML = '';
                            videoWrapper.appendChild(video);
                            // 如果之前在播放，恢复播放
                            if (wasPlaying && video.srcObject) {
                                video.play().catch(err => {
                                    console.error(`设备 ${deviceUDID}: 移动后恢复播放失败:`, err);
                                });
                            }
                        }
                        
                        // 如果当前在全屏模式，更新全屏界面的视频显示和工具栏状态
                        if (currentFullscreenDeviceUDID === deviceUDID) {
                            updateFullscreenVideo(deviceUDID, video);
                            // 重新创建全屏控制栏以更新按钮状态
                            createFullscreenControls(deviceUDID);
                        }
                        
                        // 定期更新状态（显示帧率等信息，但不显示UI）
                        let frameCount = 0;
                        const statusUpdateInterval = setInterval(() => {
                            if (!activeWebRTCConnections.has(deviceUDID)) {
                                clearInterval(statusUpdateInterval);
                                return;
                            }
                            frameCount++;
                            // 可以在这里添加更多状态信息
                        }, 1000);
                        
                        console.log(`设备 ${deviceUDID} WebRTC流已建立`);
                        return; // 成功，直接返回
                    }
                }
                
                // 如果是500错误，可能是服务正在启动，重试
                if (response.status === 500 && retries < maxRetries - 1) {
                    // 尝试读取错误信息（如果body还没被读取）
                    let errorMessage = `服务器错误 (${response.status})`;
                    try {
                        const errorData = await response.json();
                        errorMessage = errorData.error || errorMessage;
                    } catch (e) {
                        // body已被读取或不是JSON，使用默认错误信息
                    }
                    console.log(`设备 ${deviceUDID}: ${errorMessage}，重试中... (${retries + 1}/${maxRetries})`);
                    retries++;
                    // 确保使用正确的容器
                    const targetContainer = getCorrectContainer(deviceUDID, container);
                    targetContainer.innerHTML = `<p>正在启动视频流服务，请稍候... (${retries}/${maxRetries})</p>`;
                    for (let elapsed = 0; elapsed < retryDelay; elapsed += retryCheckInterval) {
                        if (getDeviceConnectionState(deviceUDID) !== DeviceConnectionState.CONNECTING) {
                            console.log(`设备 ${deviceUDID}: 用户已断开，停止连接重试`);
                            return;
                        }
                        await new Promise(resolve => setTimeout(resolve, retryCheckInterval));
                    }
                    continue;
                }
                
                // 其他错误，尝试读取错误信息
                let errorMessage = `服务器响应错误: ${response.status}`;
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.error || errorMessage;
                } catch (e) {
                    // body已被读取或不是JSON，使用默认错误信息
                }
                throw new Error(errorMessage);
            } catch (error) {
                if (retries < maxRetries - 1 && (error.message.includes('启动') || error.message.includes('500'))) {
                    retries++;
                    // 确保使用正确的容器
                    const targetContainer = getCorrectContainer(deviceUDID, container);
                    targetContainer.innerHTML = `<p>正在启动视频流服务，请稍候... (${retries}/${maxRetries})</p>`;
                    for (let elapsed = 0; elapsed < retryDelay; elapsed += retryCheckInterval) {
                        if (getDeviceConnectionState(deviceUDID) !== DeviceConnectionState.CONNECTING) {
                            console.log(`设备 ${deviceUDID}: 用户已断开，停止连接重试`);
                            return;
                        }
                        await new Promise(resolve => setTimeout(resolve, retryCheckInterval));
                    }
                    continue;
                }
                throw error;
            }
        }
        
        // 如果到这里说明重试失败
        throw new Error('服务器响应错误：重试次数已用完');
        
        // 设置远程Answer
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        
        // 确保使用正确的容器（对应设备的video-wrapper）
        const targetContainer = getCorrectContainer(deviceUDID, container);
        // 更新连接中的container引用
        const conn = activeWebRTCConnections.get(deviceUDID);
        if (conn) {
            conn.container = targetContainer;
            activeWebRTCConnections.set(deviceUDID, conn);
        }
        // 恢复视频元素显示（在正确的容器中，如果video不在容器中才移动）
        if (!targetContainer.contains(video)) {
            // 先保存播放状态
            const wasPlaying = !video.paused;
            // 先移除video元素（如果它在其他容器中）
            if (video.parentElement) {
                video.parentElement.removeChild(video);
            }
            targetContainer.innerHTML = '';
            targetContainer.appendChild(video);
            // video元素已添加到容器
            // 如果之前在播放，恢复播放
            if (wasPlaying && video.srcObject) {
                video.play().catch(err => {
                    console.error(`设备 ${deviceUDID}: 移动后恢复播放失败:`, err);
                });
            }
        } else {
            // video元素已在容器中，无需移动
        }
        
        const deviceIdForDom = getDeviceIdForApiUdid(deviceUDID);
        const overlaySafeId = safeIdFromUdid(deviceIdForDom);
        let inputOverlay = document.getElementById(`input-overlay-${overlaySafeId}`);
        if (!inputOverlay) {
            inputOverlay = document.createElement('div');
            inputOverlay.id = `input-overlay-${overlaySafeId}`;
            inputOverlay.dataset.udid = deviceUDID;
            inputOverlay.className = 'keyboard-input-overlay';
            inputOverlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: transparent;
                z-index: 10;
                cursor: default;
                pointer-events: auto;
                outline: none;
            `;
            // 确保容器是相对定位
            targetContainer.style.position = 'relative';
            targetContainer.appendChild(inputOverlay);
            // 已创建键盘输入覆盖层
        }
        
        // 创建文本输入框UI（点击视频时显示）
        createTextInputPanel(deviceUDID, targetContainer);
        
        // 设置控制面板和键盘输入覆盖层
        setupControlPanel(deviceUDID);

        console.log(`设备 ${deviceUDID} WebRTC流已建立`);
        // 按钮启用由 channel.onopen 时 setDeviceConnectionState(CONNECTED) 统一驱动

    } catch (error) {
        console.error('WebRTC初始化失败:', error);
        // 确保使用正确的容器
        const targetContainer = getCorrectContainer(deviceUDID, container);
        targetContainer.innerHTML = '<p>WebRTC流初始化失败: ' + error.message + '</p>';
        // 设置连接状态为未连接
        setDeviceConnectionState(deviceUDID, DeviceConnectionState.DISCONNECTED);
        // 清理失败的连接
        cleanupWebRTCConnection(deviceUDID);
    }
}

// 清理WebRTC连接
function cleanupWebRTCConnection(deviceUDID) {
    const conn = activeWebRTCConnections.get(deviceUDID);
    if (!conn) {
        return;
    }
    
    console.log(`清理设备 ${deviceUDID} 的WebRTC连接...`);
    if (conn.colorCorrectStop) {
        conn.colorCorrectStop();
        conn.colorCorrectStop = null;
    }
    
    // 清除状态检查定时器
    if (conn.statusCheckInterval) {
        clearInterval(conn.statusCheckInterval);
        conn.statusCheckInterval = null;
        console.log(`设备 ${deviceUDID} 状态检查定时器已清除`);
    }
    
    // 清理心跳定时器
    if (conn.heartbeatInterval) {
        clearInterval(conn.heartbeatInterval);
        conn.heartbeatInterval = null;
        console.log(`设备 ${deviceUDID} 心跳定时器已清除`);
    }
    
    // 清理DataChannel事件监听器并关闭
    if (conn.dataChannel) {
        // 移除所有事件监听器
        conn.dataChannel.onopen = null;
        conn.dataChannel.onclose = null;
        conn.dataChannel.onerror = null;
        conn.dataChannel.onmessage = null;
        
        // 关闭DataChannel
        if (conn.dataChannel.readyState !== 'closed') {
            conn.dataChannel.close();
        }
        console.log(`设备 ${deviceUDID} DataChannel已关闭并清理事件监听器`);
    }
    
    // 清理PeerConnection事件监听器并关闭
    if (conn.pc) {
        // 移除所有事件监听器（防止在关闭过程中触发事件）
        conn.pc.onconnectionstatechange = null;
        conn.pc.oniceconnectionstatechange = null;
        conn.pc.onicecandidateerror = null;
        conn.pc.onicegatheringstatechange = null;
        conn.pc.ondatachannel = null;
        conn.pc.onerror = null;
        conn.pc.ontrack = null;
        
        // 关闭PeerConnection
        if (conn.pc.connectionState !== 'closed') {
            conn.pc.close();
        }
        console.log(`设备 ${deviceUDID} PeerConnection已关闭并清理事件监听器`);
    }
    
    // 清理视频流和轨道
    if (conn.video) {
        // 停止所有视频轨道
        if (conn.video.srcObject) {
            conn.video.srcObject.getTracks().forEach(track => {
                track.stop();
                // 移除轨道事件监听器
                track.onended = null;
                track.onmute = null;
                track.onunmute = null;
            });
            conn.video.srcObject = null;
        }
        
        // 移除视频元素的事件监听器
        const videoClone = conn.video.cloneNode(false);
        if (conn.video.parentNode) {
            conn.video.parentNode.replaceChild(videoClone, conn.video);
        }
        console.log(`设备 ${deviceUDID} 视频流已清理`);
    }
    
    // 清理combinedStream
    if (conn.combinedStream) {
        conn.combinedStream.getTracks().forEach(track => track.stop());
        conn.combinedStream = null;
    }
    
    const deviceIdForDom = getDeviceIdForApiUdid(deviceUDID);
    const safeId = safeIdFromUdid(deviceIdForDom);
    const inputOverlay = document.getElementById(`input-overlay-${safeId}`);
    if (inputOverlay && inputOverlay.parentElement) {
        inputOverlay.parentElement.removeChild(inputOverlay);
        console.log(`设备 ${deviceUDID} 键盘输入覆盖层已移除`);
    }
    
    const textInputPanel = document.getElementById(`text-input-panel-${safeId}`);
    if (textInputPanel && textInputPanel.parentElement) {
        textInputPanel.parentElement.removeChild(textInputPanel);
        console.log(`设备 ${deviceUDID} 文本输入面板已移除`);
    }
    
    // 从Map中移除（必须在最后，防止其他代码访问到已清理的连接）
    activeWebRTCConnections.delete(deviceUDID);
    
    // 设置连接状态为未连接（会同步禁用控制按钮并更新 UI）
    setDeviceConnectionState(deviceUDID, DeviceConnectionState.DISCONNECTED);
    
    // 恢复连接UI（显示连接按钮）
    restoreConnectionUI(deviceUDID);
    
    // 如果当前在全屏模式，更新全屏界面显示连接按钮
    if (currentFullscreenDeviceUDID === deviceUDID) {
        updateFullscreenDisconnectedUI(deviceUDID);
    }

    // 如果清理的是当前活跃设备，清空活跃设备标记
    if (currentActiveDeviceUDID === deviceUDID) {
        currentActiveDeviceUDID = null;
        console.log(`设备 ${deviceUDID} 是当前活跃设备，已清空活跃设备标记`);
    }

    console.log(`设备 ${deviceUDID} WebRTC连接已完全清理完成`);
}

// 恢复连接UI（显示连接按钮）
function restoreConnectionUI(deviceUDID) {
    const wrapper = findWrapperByApiUdid(deviceUDID);
    if (!wrapper) return;
    const card = wrapper.querySelector('.device-video-card');
    const videoWrapper = card && card.querySelector('.device-video-wrapper');
    if (!videoWrapper) return;
    const video = videoWrapper.querySelector('video');
    if (video) {
        if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
        video.remove();
    }
    const model = card.dataset.model || '未知型号';
    videoWrapper.innerHTML = getLoadingStateHTML(model, deviceUDID);
    const startStreamBtn = videoWrapper.querySelector('.start-stream-btn');
    if (startStreamBtn) {
        startStreamBtn.onclick = (e) => {
            e.stopPropagation();
            const w = e.currentTarget && e.currentTarget.closest('.device-card-wrapper');
            if (!w) return;
            const c = w.querySelector('.device-video-card');
            const apiUdid = getApiUdidForCard(w);
            const vw = c && c.querySelector('.device-video-wrapper');
            if (apiUdid && vw) startDeviceStream(apiUdid, vw);
        };
    }
}

// 处理断开连接按钮点击（deviceUDID 为当前 apiUdid，来自 getApiUdidForCard）
function handleDisconnectClick(deviceUDID) {
    const connectionState = getDeviceConnectionState(deviceUDID);
    if (connectionState === DeviceConnectionState.DISCONNECTED) {
        const wrapper = findWrapperByApiUdid(deviceUDID);
        if (wrapper) {
            const card = wrapper.querySelector('.device-video-card');
            const startStreamBtn = card && card.querySelector('.start-stream-btn');
            const videoWrapper = card && card.querySelector('.device-video-wrapper');
            if (startStreamBtn) startStreamBtn.click();
            else if (videoWrapper) startDeviceStream(deviceUDID, videoWrapper);
        }
    } else if (connectionState === DeviceConnectionState.CONNECTING || connectionState === DeviceConnectionState.CONNECTED) {
        requestDisconnectConfirmation(deviceUDID);
    }
}

// 显示确认对话框（在设备卡片内显示，全屏模式下在全屏容器内显示）
function showConfirmDialog(deviceUDID, title, message, onConfirm, onCancel) {
    // 检查是否在全屏模式下
    const isFullscreen = currentFullscreenDeviceUDID === deviceUDID;
    let container;
    
    if (isFullscreen) {
        // 全屏模式下，显示在全屏容器内
        const focusVideoWrapper = document.getElementById('focus-video-wrapper');
        if (!focusVideoWrapper) {
            console.error(`全屏模式下未找到全屏视频容器: ${deviceUDID}`);
            return;
        }
        container = focusVideoWrapper;
    } else {
        // 非全屏模式，显示在设备卡片内
        const card = document.querySelector(`.device-video-card[data-udid="${CSS.escape(deviceUDID)}"]`);
        if (!card) {
            console.error(`未找到设备卡片: ${deviceUDID}`);
            return;
        }
        container = card;
        // 确保卡片是相对定位
        if (getComputedStyle(card).position === 'static') {
            card.style.position = 'relative';
        }
    }
    
    // 创建遮罩层
    const overlay = document.createElement('div');
    overlay.id = `confirm-dialog-overlay-${deviceUDID}`;
    overlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: ${isFullscreen ? '3000' : '1000'};
        ${isFullscreen ? '' : 'border-radius: 8px;'}
    `;
    
    // 创建对话框
    const dialog = document.createElement('div');
    dialog.style.cssText = `
        background: white;
        border-radius: 12px;
        padding: 20px;
        max-width: 280px;
        width: 85%;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
        animation: dialogFadeIn 0.2s ease-out;
    `;
    
    // 添加动画样式（如果还没有）
    if (!document.getElementById('confirm-dialog-styles')) {
        const style = document.createElement('style');
        style.id = 'confirm-dialog-styles';
        style.textContent = `
            @keyframes dialogFadeIn {
                from {
                    opacity: 0;
                    transform: scale(0.9);
                }
                to {
                    opacity: 1;
                    transform: scale(1);
                }
            }
        `;
        document.head.appendChild(style);
    }
    
    const deviceIdForDom = getDeviceIdForApiUdid(deviceUDID);
    const confirmDialogSafeId = safeIdFromUdid(deviceIdForDom);
    dialog.innerHTML = `
        <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #333; font-weight: 600;">${title}</h3>
        <p style="margin: 0 0 20px 0; font-size: 13px; color: #666; line-height: 1.5;">${message}</p>
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
            <button id="confirm-dialog-cancel-${confirmDialogSafeId}" style="
                padding: 8px 16px;
                border: 1px solid #ddd;
                background: white;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                color: #333;
                transition: all 0.2s;
            ">取消</button>
            <button id="confirm-dialog-confirm-${confirmDialogSafeId}" style="
                padding: 8px 16px;
                border: none;
                background: #e74c3c;
                color: white;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                transition: all 0.2s;
            ">确定</button>
        </div>
    `;
    
    overlay.appendChild(dialog);
    container.appendChild(overlay);
    
    // 绑定事件
    const confirmBtn = dialog.querySelector(`#confirm-dialog-confirm-${confirmDialogSafeId}`);
    const cancelBtn = dialog.querySelector(`#confirm-dialog-cancel-${confirmDialogSafeId}`);
    
    const closeDialog = () => {
        overlay.remove();
    };
    
    // 阻止对话框内的事件冒泡（防止触发全屏退出）
    dialog.onclick = (e) => {
        e.stopPropagation();
    };
    
    confirmBtn.onclick = (e) => {
        e.stopPropagation();
        closeDialog();
        if (onConfirm) onConfirm();
    };
    
    cancelBtn.onclick = (e) => {
        e.stopPropagation();
        closeDialog();
        if (onCancel) onCancel();
    };
    
    overlay.onclick = (e) => {
        // 阻止事件冒泡到全屏模式（防止退出全屏）
        e.stopPropagation();
        if (e.target === overlay) {
            closeDialog();
            if (onCancel) onCancel();
        }
    };
    
    // 添加按钮悬停效果
    confirmBtn.onmouseenter = () => {
        confirmBtn.style.background = '#c0392b';
    };
    confirmBtn.onmouseleave = () => {
        confirmBtn.style.background = '#e74c3c';
    };
    
    cancelBtn.onmouseenter = () => {
        cancelBtn.style.background = '#f5f5f5';
    };
    cancelBtn.onmouseleave = () => {
        cancelBtn.style.background = 'white';
    };
}

// 请求断开连接确认（在网页上显示确认对话框，在手机上显示提示）
function requestDisconnectConfirmation(deviceUDID) {
    // 在设备卡片内显示确认对话框
    showConfirmDialog(
        deviceUDID,
        '断开连接',
        '确定要断开连接吗？断开后需要重新连接才能继续使用。',
        () => {
            // 用户确认断开
            console.log(`用户确认断开设备 ${deviceUDID} 的连接`);
            
            
            // 通知后端：带 sessionId 时只摘本页这一路，避免同设备多开时整设备 teardown
            const connDisc = activeWebRTCConnections.get(deviceUDID);
            const discSid = connDisc && connDisc.sessionId;
            const discOpts = { method: 'POST' };
            if (discSid) {
                discOpts.headers = { 'Content-Type': 'application/json' };
                discOpts.body = JSON.stringify({ sessionId: discSid });
            }
            fetch(`/api/device/${encodeURIComponent(deviceUDID)}/webrtc/disconnect`, discOpts).catch(err => {
                console.error('通知后端断开连接失败:', err);
            });
            
            // 先设置连接状态为未连接（防止被 onclose 事件覆盖）
            setDeviceConnectionState(deviceUDID, DeviceConnectionState.DISCONNECTED);
            // 断开连接
            cleanupWebRTCConnection(deviceUDID);
            showNotification('已断开连接', deviceUDID, 2000);
        },
        () => {
            // 用户取消
            console.log(`用户取消断开设备 ${deviceUDID} 的连接`);
        }
    );
}

// 更新断开连接按钮的图标和标题（用 getControlPanelsForDevice 以便全屏下面板移出 wrapper 时仍能找到）
function updateDisconnectButton(deviceUDID, connectionState) {
    const rightPanel = getControlPanelsForDevice(deviceUDID).find(p => p.querySelector('.disconnect-btn'));
    if (!rightPanel) return;
    const disconnectBtn = rightPanel.querySelector('.disconnect-btn');
    if (!disconnectBtn) return;
    
    // 如果传入的是布尔值（兼容旧代码）
    if (typeof connectionState === 'boolean') {
        connectionState = connectionState ? DeviceConnectionState.CONNECTED : DeviceConnectionState.DISCONNECTED;
    } else if (!connectionState) {
        connectionState = getDeviceConnectionState(deviceUDID);
    }
    
    if (connectionState === DeviceConnectionState.CONNECTED) {
        disconnectBtn.textContent = '⛓️‍💥';
        disconnectBtn.title = '断开连接';
    } else if (connectionState === DeviceConnectionState.CONNECTING) {
        disconnectBtn.textContent = '🔗';
        disconnectBtn.title = '断开连接';
    } else {
        disconnectBtn.textContent = '🔗';
        disconnectBtn.title = '连接';
    }
}

// 对单个面板应用按钮启用/禁用（不包含 info、disconnect、fullscreen、shell）
function applyControlButtonsToPanel(panel, enabled) {
    if (!panel) return;
    const buttons = panel.querySelectorAll('.control-btn-icon:not(.info-btn):not(.disconnect-btn):not(.fullscreen-btn):not(.shell-btn)');
    buttons.forEach(btn => {
        if (enabled) {
            btn.removeAttribute('disabled');
            btn.style.removeProperty('opacity');
            btn.style.removeProperty('cursor');
            const originalTitle = btn.getAttribute('data-original-title') || btn.title;
            if (originalTitle && !originalTitle.includes('（需要连接）')) {
                btn.title = originalTitle;
            } else {
                btn.title = (btn.title || '').replace('（需要连接）', '');
            }
        } else {
            btn.setAttribute('disabled', 'disabled');
            btn.style.removeProperty('opacity');
            btn.style.removeProperty('cursor');
            if (!btn.getAttribute('data-original-title')) {
                btn.setAttribute('data-original-title', btn.title || '');
            }
            if (!(btn.title || '').includes('（需要连接）')) {
                btn.title = (btn.title || '') + '（需要连接）';
            }
        }
    });
}

// 更新所有控制按钮状态（用 getControlPanelsForDevice 以便全屏下面板移出 wrapper 时仍能更新）
function updateControlButtonsState(deviceUDID, enabled) {
    getControlPanelsForDevice(deviceUDID).forEach(p => applyControlButtonsToPanel(p, enabled));
}

// 事件类型定义
const EventType = {
    TOUCH: 'touch',
    SCROLL: 'scroll',
    OTHER: 'other'
};

// 触摸事件对象
function createTouchEvent(action, pointerId, relativeX, relativeY, sourceScreenWidth, sourceScreenHeight) {
    return {
        type: EventType.TOUCH,
        action,
        pointerId,
        relativeX,  // 相对位置（0-1）
        relativeY,  // 相对位置（0-1）
        sourceScreenWidth,
        sourceScreenHeight
    };
}

// 滚动事件对象
function createScrollEvent(relativeX, relativeY, sourceScreenWidth, sourceScreenHeight, hscroll, vscroll, buttons) {
    return {
        type: EventType.SCROLL,
        relativeX,  // 相对位置（0-1）
        relativeY,  // 相对位置（0-1）
        sourceScreenWidth,
        sourceScreenHeight,
        hscroll,
        vscroll,
        buttons
    };
}

// 解析控制消息，提取事件信息
function parseControlMessage(messageType, dataArray) {
    const INJECT_TOUCH_EVENT = 0x02;
    const INJECT_SCROLL_EVENT = 0x03;

    // 工具函数：从big-endian字节数组读取值
    const readInt64BE = (bytes) => {
        return (bytes[0] << 56) | (bytes[1] << 48) | (bytes[2] << 40) | (bytes[3] << 32) |
               (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
    };
    const readInt32BE = (bytes) => {
        return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    };
    const readInt16BE = (bytes) => {
        return (bytes[0] << 8) | bytes[1];
    };

    if (messageType === INJECT_TOUCH_EVENT && dataArray.length >= 25) {
        // 解析触摸事件：action(1) + pointerId(8) + x(4) + y(4) + screenWidth(2) + screenHeight(2) + ...
        const action = dataArray[0];
        const pointerIdBytes = dataArray.slice(1, 9);
        const xBytes = dataArray.slice(9, 13);
        const yBytes = dataArray.slice(13, 17);
        const screenWidthBytes = dataArray.slice(17, 19);
        const screenHeightBytes = dataArray.slice(19, 21);

        const pointerId = readInt64BE(pointerIdBytes);
        const x = readInt32BE(xBytes);
        const y = readInt32BE(yBytes);
        const sourceScreenWidth = readInt16BE(screenWidthBytes);
        const sourceScreenHeight = readInt16BE(screenHeightBytes);

        const relativeX = sourceScreenWidth > 0 ? x / sourceScreenWidth : 0;
        const relativeY = sourceScreenHeight > 0 ? y / sourceScreenHeight : 0;

        return createTouchEvent(action, pointerId, relativeX, relativeY, sourceScreenWidth, sourceScreenHeight);
    } else if (messageType === INJECT_SCROLL_EVENT && dataArray.length >= 20) {
        // 解析滚动事件：x(4) + y(4) + screenWidth(2) + screenHeight(2) + hscroll(2) + vscroll(2) + buttons(4)
        const xBytes = dataArray.slice(0, 4);
        const yBytes = dataArray.slice(4, 8);
        const screenWidthBytes = dataArray.slice(8, 10);
        const screenHeightBytes = dataArray.slice(10, 12);
        const hscrollBytes = dataArray.slice(12, 14);
        const vscrollBytes = dataArray.slice(14, 16);
        const buttonsBytes = dataArray.slice(16, 20);

        const x = readInt32BE(xBytes);
        const y = readInt32BE(yBytes);
        const sourceScreenWidth = readInt16BE(screenWidthBytes);
        const sourceScreenHeight = readInt16BE(screenHeightBytes);
        const hscroll = readInt16BE(hscrollBytes);
        const vscroll = readInt16BE(vscrollBytes);
        const buttons = readInt32BE(buttonsBytes);

        // 计算相对位置（百分比）
        const relativeX = sourceScreenWidth > 0 ? x / sourceScreenWidth : 0;
        const relativeY = sourceScreenHeight > 0 ? y / sourceScreenHeight : 0;

        return createScrollEvent(relativeX, relativeY, sourceScreenWidth, sourceScreenHeight, hscroll, vscroll, buttons);
    }

    return null;
}

// 设备控件类：负责处理事件和坐标转换
class DeviceController {
    constructor(deviceUDID, connection) {
        this.deviceUDID = deviceUDID;
        this.connection = connection;
    }

    // 检查连接是否可用
    isConnected() {
        return this.connection && 
               this.connection.dataChannel && 
               this.connection.dataChannel.readyState === 'open';
    }

    // 获取设备屏幕尺寸
    getScreenSize() {
        if (!window.ControlCommands) {
            return { width: 1080, height: 1920 }; // 默认值
        }
        return window.ControlCommands.getDeviceScreenSize(this.deviceUDID);
    }

    // 处理触摸事件：根据设备屏幕尺寸计算坐标并构建消息
    handleTouchEvent(event, messageType, originalDataArray) {
        if (!event || event.type !== EventType.TOUCH || !window.ControlCommands) {
            console.error(`[TOUCH] handleTouchEvent 参数无效 - event:`, event, `window.ControlCommands:`, !!window.ControlCommands);
            return null;
        }

        const toBigEndianBytes = window.ControlCommands.toBigEndianBytes;
        const screenSize = this.getScreenSize();
        let targetX, targetY;

        const isMultiTouch = event.action === 5 || event.action === 6;
        
        if (isMultiTouch && event.pointerId === 0) {
            targetX = Math.round(screenSize.width / 2);
            targetY = Math.round(screenSize.height / 2);
        } else {
            targetX = Math.round(event.relativeX * screenSize.width);
            targetY = Math.round(event.relativeY * screenSize.height);
            targetX = Math.max(0, Math.min(targetX, screenSize.width - 1));
            targetY = Math.max(0, Math.min(targetY, screenSize.height - 1));
        }

        const action = event.action;
        const pointerIdBytes = originalDataArray.slice(1, 9);
        const pressure = 0xFFFF;
        const actionButton = 0;
        const buttons = (action === 0 || action === 5 || action === 2) ? 1 : 0;

        const newData = new Uint8Array([
            action,
            ...pointerIdBytes,
            ...toBigEndianBytes(targetX, 4),
            ...toBigEndianBytes(targetY, 4),
            ...toBigEndianBytes(screenSize.width, 2),
            ...toBigEndianBytes(screenSize.height, 2),
            ...toBigEndianBytes(pressure, 2),
            ...toBigEndianBytes(actionButton, 4),
            ...toBigEndianBytes(buttons, 4)
        ]);

        return new Uint8Array([messageType, ...newData]);
    }

    // 处理滚动事件：根据设备屏幕尺寸计算坐标并构建消息
    handleScrollEvent(event, messageType) {
        if (!event || event.type !== EventType.SCROLL || !window.ControlCommands) {
            return null;
        }

        const toBigEndianBytes = window.ControlCommands.toBigEndianBytes;
        const screenSize = this.getScreenSize();
        const targetX = Math.round(event.relativeX * screenSize.width);
        const targetY = Math.round(event.relativeY * screenSize.height);

        // 重新构建滚动事件消息
        const newData = new Uint8Array([
            ...toBigEndianBytes(targetX, 4),
            ...toBigEndianBytes(targetY, 4),
            ...toBigEndianBytes(screenSize.width, 2),
            ...toBigEndianBytes(screenSize.height, 2),
            ...toBigEndianBytes(event.hscroll, 2),
            ...toBigEndianBytes(event.vscroll, 2),
            ...toBigEndianBytes(event.buttons, 4)
        ]);

        return new Uint8Array([messageType, ...newData]);
    }

    // 处理事件：根据事件类型分发到对应的处理方法
    handleEvent(event, messageType, originalDataArray) {
        if (!this.isConnected()) {
            console.error(`[TOUCH] handleEvent - 设备未连接 - deviceUDID: ${this.deviceUDID}`);
            return null;
        }

        if (event.type === EventType.TOUCH) {
            return this.handleTouchEvent(event, messageType, originalDataArray);
        } else if (event.type === EventType.SCROLL) {
            return this.handleScrollEvent(event, messageType);
        }

        return null;
    }

    // 发送消息到设备
    sendMessage(message) {
        if (!this.isConnected()) {
            console.error(`[TOUCH] sendMessage - 设备未连接 - deviceUDID: ${this.deviceUDID}, dataChannel状态: ${this.connection.dataChannel?.readyState}`);
            return false;
        }

        // 再次检查 DataChannel 状态（可能在检查后状态改变了）
        const dataChannel = this.connection.dataChannel;
        if (!dataChannel) {
            console.error(`[TOUCH] sendMessage - dataChannel 为 null - deviceUDID: ${this.deviceUDID}`);
            return false;
        }
        
        const readyState = dataChannel.readyState;
        
        if (readyState !== 'open') {
            console.error(`[TOUCH] sendMessage - DataChannel 未打开 - deviceUDID: ${this.deviceUDID}, readyState: ${readyState}`);
            return false;
        }

        try {
            dataChannel.send(message);
            return true;
        } catch (error) {
            console.error(`[TOUCH] sendMessage 异常 - deviceUDID: ${this.deviceUDID}, error:`, error, `error.name: ${error.name}, error.message: ${error.message}`);
            console.error(`[TOUCH] sendMessage 异常时的状态 - readyState: ${dataChannel.readyState}, bufferedAmount: ${dataChannel.bufferedAmount}`);
            return false;
        }
    }
}

// 获取设备控件实例
function getDeviceController(deviceUDID) {
    const conn = activeWebRTCConnections.get(deviceUDID);
    if (!conn) {
        return null;
    }
    return new DeviceController(deviceUDID, conn);
}

// 广播事件到指定设备列表：每个设备控件自己处理坐标转换
function broadcastEventToDevices(event, messageType, originalDataArray, targetDevices) {
    if (!event || !targetDevices || targetDevices.length === 0) {
        return [];
    }

    const affectedDevices = [];

    targetDevices.forEach(deviceUDID => {
        const controller = getDeviceController(deviceUDID);
        if (!controller) {
            const connectionState = getDeviceConnectionState(deviceUDID);
            if (connectionState === DeviceConnectionState.CONNECTED) {
                affectedDevices.push(deviceUDID);
            }
            return;
        }

        const messageToSend = controller.handleEvent(event, messageType, originalDataArray);
        
        if (messageToSend) {
            if (controller.sendMessage(messageToSend)) {
                affectedDevices.push(deviceUDID);
            } else {
                console.error(`[TOUCH] sendMessage 失败 - deviceUDID: ${deviceUDID}`);
            }
        } else {
            affectedDevices.push(deviceUDID);
        }
    });

    return affectedDevices;
}

// 发送控制消息到设备（支持同步广播和toast提示）
async function sendControlMessage(deviceUDID, messageType, dataArray = new Uint8Array(0), toastMessage = null) {
    try {
        const event = parseControlMessage(messageType, dataArray);
        
        // 确定要发送的设备列表
        let targetDevices = [deviceUDID]; // 默认只发送到源设备
        
        const syncEnabled = isSyncOperationEnabled();
        if (syncEnabled) {
            const selectedDevices = getSelectedConnectedDevices();
            
            if (selectedDevices.length === 0) {
                // 如果没有选中的已连接设备，关闭同步操作
                const syncCb = document.getElementById('sync-operation-cb');
                if (syncCb && syncOperationEnabled) {
                    syncCb.checked = false;
                    syncOperationEnabled = false;
                    showNotification('没有选中的已连接设备，已关闭同步操作', null, 3000, 'warning');
                }
                // 如果没有同步设备，只处理当前设备的toast
                if (toastMessage) {
                    showNotification(toastMessage, deviceUDID, 2000, 'info');
                }
                return true;
            }
            
            // selectedDevices 为 deviceId 列表；当前触发源 deviceUDID 为 apiUdid，需转成 deviceId 再比较
            const sourceDeviceId = getDeviceIdForApiUdid(deviceUDID);
            if (selectedDevices.includes(sourceDeviceId)) {
                // 发往选中设备时用 apiUdid（getDeviceController/广播用 apiUdid）
                targetDevices = selectedDevices.map(did => getApiUdid(did)).filter(Boolean);
            }
        }
        
        let affectedDevices = [];
        
        if (event) {
            affectedDevices = broadcastEventToDevices(event, messageType, dataArray, targetDevices);
        } else {
            const message = new Uint8Array([messageType, ...dataArray]);
            targetDevices.forEach(targetUDID => {
                const controller = getDeviceController(targetUDID);
                if (controller && controller.sendMessage(message)) {
                    affectedDevices.push(targetUDID);
                } else {
                    // 如果dataChannel未打开，但仍然已连接，也加入列表用于toast
                    const connectionState = getDeviceConnectionState(targetUDID);
                    if (connectionState === DeviceConnectionState.CONNECTED) {
                        console.warn(`发送控制消息: 设备 ${targetUDID} 已连接但dataChannel未打开，跳过消息发送，但仍会发送toast`);
                        affectedDevices.push(targetUDID);
                    }
                }
            });
        }
        
        // 如果有toast消息，为每个受影响的设备在前端页面显示toast提示
        if (toastMessage && affectedDevices.length > 0) {
            affectedDevices.forEach(targetUDID => {
                showNotification(toastMessage, targetUDID, 2000, 'info');
            });
        }
        
        return true;
    } catch (error) {
        console.error(`设备 ${deviceUDID}: 发送控制消息失败:`, error);
        return false;
    }
}

// 设备消息类型（服务器 → 客户端）
const DeviceMessageType = {
    CLIPBOARD: 0x00,
    ACK_CLIPBOARD: 0x01,
    UHID_OUTPUT: 0x02
};

// 处理从服务器接收的设备消息
function handleDeviceMessage(deviceUDID, data) {
    // DataChannel 可能发送 ArrayBuffer 或 Blob
    if (data instanceof Blob) {
        data.arrayBuffer().then(buffer => {
            handleDeviceMessageBuffer(deviceUDID, new Uint8Array(buffer));
        });
        return;
    }
    
    if (data instanceof ArrayBuffer) {
        handleDeviceMessageBuffer(deviceUDID, new Uint8Array(data));
        return;
    }
    
    // 如果已经是 Uint8Array
    if (data instanceof Uint8Array) {
        handleDeviceMessageBuffer(deviceUDID, data);
        return;
    }
    
    console.warn(`设备 ${deviceUDID}: 收到未知格式的DataChannel消息:`, typeof data);
}

// 处理设备消息缓冲区
function handleDeviceMessageBuffer(deviceUDID, buffer) {
    if (buffer.length === 0) {
        console.warn(`设备 ${deviceUDID}: 收到空消息`);
        return;
    }
    
    const messageType = buffer[0];
    let offset = 1;
    
    try {
        switch (messageType) {
            case DeviceMessageType.CLIPBOARD:
                // [1字节类型] [变长字符串长度] [字符串内容]
                if (buffer.length < 2) {
                    console.warn(`设备 ${deviceUDID}: 剪贴板消息格式错误（长度不足）`);
                    return;
                }
                
                // 读取字符串长度（Java DataOutputStream.writeInt() 格式：4字节 big-endian）
                if (buffer.length < offset + 4) {
                    console.warn(`设备 ${deviceUDID}: 剪贴板消息格式错误（长度字段不完整）`);
                    return;
                }
                const length = (buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
                offset += 4;
                
                if (buffer.length < offset + length) {
                    console.warn(`设备 ${deviceUDID}: 剪贴板消息格式错误（内容不完整）`);
                    return;
                }
                
                // 读取字符串内容
                const textBytes = buffer.slice(offset, offset + length);
                const text = new TextDecoder('utf-8').decode(textBytes);
                
                console.log(`设备 ${deviceUDID}: 收到剪贴板内容 (长度: ${length}): "${text}"`);
                
                // 触发剪贴板事件，供外部监听
                const event = new CustomEvent('deviceClipboard', {
                    detail: { deviceUDID, text }
                });
                window.dispatchEvent(event);
                
                // 如果剪贴板为空，提示用户
                if (text.length === 0) {
                    console.log(`设备 ${deviceUDID}: 剪贴板内容为空`);
                }
                break;
                
            case DeviceMessageType.ACK_CLIPBOARD:
                // [1字节类型] [8字节sequence]
                if (buffer.length < 9) {
                    console.warn(`设备 ${deviceUDID}: 剪贴板确认消息格式错误（长度不足）`);
                    return;
                }
                
                // 读取 sequence（8字节，big-endian）
                let sequence = 0;
                for (let i = 0; i < 8; i++) {
                    sequence = (sequence << 8) | buffer[offset + i];
                }
                
                console.log(`设备 ${deviceUDID}: 收到剪贴板设置确认 (sequence: ${sequence})`);
                
                // 触发剪贴板确认事件
                const ackEvent = new CustomEvent('deviceClipboardAck', {
                    detail: { deviceUDID, sequence }
                });
                window.dispatchEvent(ackEvent);
                break;
                
            case DeviceMessageType.UHID_OUTPUT:
                // [1字节类型] [变长数据]
                const uhidData = buffer.slice(offset);
                console.log(`设备 ${deviceUDID}: 收到UHID输出 (长度: ${uhidData.length} 字节)`);
                
                // 触发 UHID 输出事件
                const uhidEvent = new CustomEvent('deviceUhidOutput', {
                    detail: { deviceUDID, data: uhidData }
                });
                window.dispatchEvent(uhidEvent);
                break;
                
            default:
                console.warn(`设备 ${deviceUDID}: 收到未知设备消息类型: 0x${messageType.toString(16).padStart(2, '0')}`);
        }
    } catch (error) {
        console.error(`设备 ${deviceUDID}: 处理设备消息失败:`, error);
    }
}

// 设置视频元素的鼠标事件处理（scrcpy风格）
function setupVideoMouseEvents(deviceUDID, video) {
    // 避免重复绑定事件
    if (video.dataset.mouseEventsSetup === 'true') {
        return;
    }
    video.dataset.mouseEventsSetup = 'true';
    
    let isDragging = false;
    let lastTouchX = 0;
    let lastTouchY = 0;
    let touchStartTime = 0;
    let activeTouchId = null;
    
    // 双指操作状态
    let isTwoFingerMode = false;
    let firstFingerX = 0;
    let firstFingerY = 0;
    let secondFingerX = 0;
    let secondFingerY = 0;
    
    // 双指操作可视化元素
    let touchOverlay = null;
    let firstFingerIndicator = null;
    let secondFingerIndicator = null;
    let touchLine = null;
    
    // 创建双指操作可视化覆盖层
    function createTouchOverlay() {
        if (touchOverlay) return touchOverlay;
        
        touchOverlay = document.createElement('div');
        touchOverlay.className = 'touch-overlay';
        touchOverlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1000;
        `;
        
        // 第一个触摸点指示器（深蓝色）
        firstFingerIndicator = document.createElement('div');
        firstFingerIndicator.className = 'touch-indicator touch-indicator-1';
        firstFingerIndicator.style.cssText = `
            position: absolute;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            background: rgba(52, 152, 219, 0.5);
            border: 2px solid rgba(52, 152, 219, 0.9);
            transform: translate(-50%, -50%);
            display: none;
            pointer-events: none;
        `;
        
        // 第二个触摸点指示器（浅蓝色）
        secondFingerIndicator = document.createElement('div');
        secondFingerIndicator.className = 'touch-indicator touch-indicator-2';
        secondFingerIndicator.style.cssText = `
            position: absolute;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            background: rgba(135, 206, 250, 0.5);
            border: 2px solid rgba(135, 206, 250, 0.9);
            transform: translate(-50%, -50%);
            display: none;
            pointer-events: none;
        `;
        
        // 连接线（蓝色）
        touchLine = document.createElement('div');
        touchLine.className = 'touch-line';
        touchLine.style.cssText = `
            position: absolute;
            height: 2px;
            background: rgba(100, 181, 246, 0.7);
            transform-origin: left center;
            display: none;
            pointer-events: none;
        `;
        
        touchOverlay.appendChild(firstFingerIndicator);
        touchOverlay.appendChild(secondFingerIndicator);
        touchOverlay.appendChild(touchLine);
        
        // 将覆盖层添加到视频的父容器
        // 可能是 device-video-wrapper（普通模式）或 focus-video-wrapper（全屏模式）
        const videoWrapper = video.parentElement;
        if (videoWrapper) {
            // 确保父容器是相对定位
            const wrapperStyle = getComputedStyle(videoWrapper);
            if (wrapperStyle.position === 'static') {
                videoWrapper.style.position = 'relative';
            }
            // 检查是否已经存在覆盖层，如果存在则先移除
            const existingOverlay = videoWrapper.querySelector('.touch-overlay');
            if (existingOverlay) {
                existingOverlay.remove();
            }
            videoWrapper.appendChild(touchOverlay);
        }
        
        return touchOverlay;
    }
    
    // 更新双指操作可视化
    function updateTouchVisualization() {
        if (!isTwoFingerMode || !touchOverlay) return;
        
        const videoRect = video.getBoundingClientRect();
        const deviceSize = getDeviceSize();
        
        // 获取覆盖层父容器（覆盖层所在的容器）的边界矩形
        const overlayParent = touchOverlay.parentElement;
        if (!overlayParent) return;
        
        const parentRect = overlayParent.getBoundingClientRect();
        
        // 计算视频相对于父容器的位置
        const videoRelativeX = videoRect.left - parentRect.left;
        const videoRelativeY = videoRect.top - parentRect.top;
        
        // 计算视频在容器中的实际显示区域（与 convertToDeviceCoordinates 相同的逻辑）
        const videoAspect = deviceSize.width / deviceSize.height;
        const containerAspect = videoRect.width / videoRect.height;
        
        let displayWidth, displayHeight, offsetX, offsetY;
        
        if (videoAspect > containerAspect) {
            displayWidth = videoRect.width;
            displayHeight = videoRect.width / videoAspect;
            offsetX = videoRelativeX;
            offsetY = videoRelativeY + (videoRect.height - displayHeight) / 2;
        } else {
            displayWidth = videoRect.height * videoAspect;
            displayHeight = videoRect.height;
            offsetX = videoRelativeX + (videoRect.width - displayWidth) / 2;
            offsetY = videoRelativeY;
        }
        
        // 将设备坐标转换为相对于父容器的显示坐标
        const firstX = (firstFingerX / deviceSize.width) * displayWidth + offsetX;
        const firstY = (firstFingerY / deviceSize.height) * displayHeight + offsetY;
        const secondX = (secondFingerX / deviceSize.width) * displayWidth + offsetX;
        const secondY = (secondFingerY / deviceSize.height) * displayHeight + offsetY;
        
        // 更新第一个触摸点位置
        firstFingerIndicator.style.left = firstX + 'px';
        firstFingerIndicator.style.top = firstY + 'px';
        firstFingerIndicator.style.display = 'block';
        
        // 更新第二个触摸点位置
        secondFingerIndicator.style.left = secondX + 'px';
        secondFingerIndicator.style.top = secondY + 'px';
        secondFingerIndicator.style.display = 'block';
        
        // 更新连接线
        const dx = secondX - firstX;
        const dy = secondY - firstY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        
        touchLine.style.left = firstX + 'px';
        touchLine.style.top = firstY + 'px';
        touchLine.style.width = distance + 'px';
        touchLine.style.transform = `rotate(${angle}deg)`;
        touchLine.style.display = 'block';
    }
    
    // 隐藏双指操作可视化
    function hideTouchVisualization() {
        if (firstFingerIndicator) firstFingerIndicator.style.display = 'none';
        if (secondFingerIndicator) secondFingerIndicator.style.display = 'none';
        if (touchLine) touchLine.style.display = 'none';
    }
    
    // 获取设备屏幕尺寸（从video元素或设备信息）
    function getDeviceSize() {
        // 优先使用video的实际尺寸
        if (video.videoWidth > 0 && video.videoHeight > 0) {
            return { width: video.videoWidth, height: video.videoHeight };
        }
        // 如果没有，尝试从设备信息获取
        // 这里可以扩展从API获取设备分辨率
        return { width: 1080, height: 1920 }; // 默认值
    }
    
    // 将视频显示坐标转换为设备屏幕坐标
    function convertToDeviceCoordinates(clientX, clientY) {
        const videoRect = video.getBoundingClientRect();
        const deviceSize = getDeviceSize();
        
        const videoAspect = deviceSize.width / deviceSize.height;
        const containerAspect = videoRect.width / videoRect.height;
        
        let displayWidth, displayHeight, offsetX, offsetY;
        
        if (videoAspect > containerAspect) {
            displayWidth = videoRect.width;
            displayHeight = videoRect.width / videoAspect;
            offsetX = 0;
            offsetY = (videoRect.height - displayHeight) / 2;
        } else {
            displayWidth = videoRect.height * videoAspect;
            displayHeight = videoRect.height;
            offsetX = (videoRect.width - displayWidth) / 2;
            offsetY = 0;
        }
        
        const relativeX = clientX - videoRect.left - offsetX;
        const relativeY = clientY - videoRect.top - offsetY;
        
        const deviceX = Math.round((relativeX / displayWidth) * deviceSize.width);
        const deviceY = Math.round((relativeY / displayHeight) * deviceSize.height);
        
        return {
            x: Math.max(0, Math.min(deviceX, deviceSize.width - 1)),
            y: Math.max(0, Math.min(deviceY, deviceSize.height - 1))
        };
    }

    function getPrimaryTouch(touchList) {
        if (!touchList || touchList.length === 0) return null;
        if (activeTouchId == null) return touchList[0];
        for (let i = 0; i < touchList.length; i++) {
            if (touchList[i].identifier === activeTouchId) return touchList[i];
        }
        return null;
    }

    function endActiveTouch(touch, action) {
        const coords = touch ? convertToDeviceCoordinates(touch.clientX, touch.clientY) : { x: lastTouchX, y: lastTouchY };
        if (window.ControlCommands) {
            window.ControlCommands.injectTouchEvent(deviceUDID, coords.x, coords.y, action, SC_POINTER_ID_MOUSE);
        }
        activeTouchId = null;
        isDragging = false;
    }
    
    // scrcpy pointerId 常量（使用 BigInt 以支持负数）
    const SC_POINTER_ID_MOUSE = -1;
    const SC_POINTER_ID_GENERIC_FINGER = -2;
    const SC_POINTER_ID_VIRTUAL_FINGER = -3;
    
    // 双指模式状态
    let vfingerInvertX = false;
    let vfingerInvertY = false;
    
    // 计算虚拟手指坐标（inverse_point）
    function calculateVirtualFinger(mouseX, mouseY, deviceSize) {
        let vfingerX = mouseX;
        let vfingerY = mouseY;
        
        if (vfingerInvertX) {
            vfingerX = deviceSize.width - mouseX;
        }
        if (vfingerInvertY) {
            vfingerY = deviceSize.height - mouseY;
        }
        
        return {
            x: Math.max(0, Math.min(vfingerX, deviceSize.width - 1)),
            y: Math.max(0, Math.min(vfingerY, deviceSize.height - 1))
        };
    }
    
    // 左键点击/拖动处理
    video.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();

        const coords = convertToDeviceCoordinates(e.clientX, e.clientY);
        
        if (isTwoFingerMode) {
            hideTouchVisualization();
            isTwoFingerMode = false;
        }
        if (isDragging) {
            isDragging = false;
        }
        
        lastTouchX = coords.x;
        lastTouchY = coords.y;
        touchStartTime = Date.now();
        isDragging = false;
        
        const ctrlPressed = e.ctrlKey;
        const shiftPressed = e.shiftKey;
        const changeVfinger = !isTwoFingerMode && (ctrlPressed || shiftPressed);
        
        if (changeVfinger) {
            // 进入双指模式
            isTwoFingerMode = true;
            const deviceSize = getDeviceSize();
            
            // 根据 Ctrl/Shift 组合设置 invert 标志（与 scrcpy 一致）
            // Ctrl  Shift     invert_x  invert_y
            // ----  ----- ==> --------  --------
            //   0     0           0         0      -
            //   0     1           1         0      vertical tilt
            //   1     0           1         1      rotate
            //   1     1           0         1      horizontal tilt
            vfingerInvertX = ctrlPressed !== shiftPressed;  // ctrl ^ shift
            vfingerInvertY = ctrlPressed;
            
            // 主手指：鼠标当前位置
            const genericFingerX = coords.x;
            const genericFingerY = coords.y;
            
            // 虚拟手指：根据 invert 标志计算
            const vfinger = calculateVirtualFinger(coords.x, coords.y, deviceSize);
            
            // 保存坐标用于后续 MOVE 和 UP
            secondFingerX = genericFingerX;
            secondFingerY = genericFingerY;
            firstFingerX = vfinger.x;
            firstFingerY = vfinger.y;
            
            createTouchOverlay();
            updateTouchVisualization();
            
            if (window.ControlCommands) {
                // 先发送主手指（GENERIC_FINGER）
                window.ControlCommands.injectTouchEvent(deviceUDID, genericFingerX, genericFingerY, window.ControlCommands.MotionAction.DOWN, SC_POINTER_ID_GENERIC_FINGER);
                // 再发送虚拟手指（VIRTUAL_FINGER）
                window.ControlCommands.injectTouchEvent(deviceUDID, vfinger.x, vfinger.y, window.ControlCommands.MotionAction.DOWN, SC_POINTER_ID_VIRTUAL_FINGER);
            } else {
                console.error(`[TOUCH] window.ControlCommands 不存在！`);
            }
        } else {
            // 单指模式：使用 MOUSE pointerId（与 scrcpy 一致）
            isTwoFingerMode = false;
            if (window.ControlCommands) {
                window.ControlCommands.injectTouchEvent(deviceUDID, coords.x, coords.y, window.ControlCommands.MotionAction.DOWN, SC_POINTER_ID_MOUSE);
            } else {
                console.error(`[TOUCH] window.ControlCommands 不存在！`);
            }
        }
    });
    
    video.addEventListener('mousemove', (e) => {
        if (e.buttons !== 1) return;
        e.preventDefault();
        
        const coords = convertToDeviceCoordinates(e.clientX, e.clientY);
        const ctrlPressed = e.ctrlKey;
        const shiftPressed = e.shiftKey;
        
        // 如果之前在双指模式，但现在修饰键已释放，需要先结束双指模式
        if (isTwoFingerMode && !(ctrlPressed || shiftPressed)) {
            if (window.ControlCommands) {
                window.ControlCommands.injectTouchEvent(deviceUDID, firstFingerX, firstFingerY, window.ControlCommands.MotionAction.UP, SC_POINTER_ID_VIRTUAL_FINGER);
                window.ControlCommands.injectTouchEvent(deviceUDID, secondFingerX, secondFingerY, window.ControlCommands.MotionAction.UP, SC_POINTER_ID_GENERIC_FINGER);
            }
            hideTouchVisualization();
            isTwoFingerMode = false;
            if (window.ControlCommands) {
                window.ControlCommands.injectTouchEvent(deviceUDID, coords.x, coords.y, window.ControlCommands.MotionAction.DOWN, SC_POINTER_ID_MOUSE);
            }
            lastTouchX = coords.x;
            lastTouchY = coords.y;
            isDragging = false;
            return;
        }
        
        if (isTwoFingerMode && (ctrlPressed || shiftPressed)) {
            // 双指模式：更新 invert 标志（如果修饰键组合改变）
            const newInvertX = ctrlPressed !== shiftPressed;
            const newInvertY = ctrlPressed;
            
            if (newInvertX !== vfingerInvertX || newInvertY !== vfingerInvertY) {
                vfingerInvertX = newInvertX;
                vfingerInvertY = newInvertY;
            }
            
            const deviceSize = getDeviceSize();
            
            // 主手指：鼠标当前位置
            secondFingerX = coords.x;
            secondFingerY = coords.y;
            
            // 虚拟手指：根据 invert 标志计算
            const vfinger = calculateVirtualFinger(coords.x, coords.y, deviceSize);
            firstFingerX = vfinger.x;
            firstFingerY = vfinger.y;
            
            updateTouchVisualization();
            
            if (window.ControlCommands) {
                // 发送主手指的 MOVE（GENERIC_FINGER）
                window.ControlCommands.injectTouchEvent(deviceUDID, coords.x, coords.y, window.ControlCommands.MotionAction.MOVE, SC_POINTER_ID_GENERIC_FINGER);
                // 发送虚拟手指的 MOVE（VIRTUAL_FINGER）
                window.ControlCommands.injectTouchEvent(deviceUDID, vfinger.x, vfinger.y, window.ControlCommands.MotionAction.MOVE, SC_POINTER_ID_VIRTUAL_FINGER);
            }
            
            lastTouchX = coords.x;
            lastTouchY = coords.y;
        } else {
            // 单指模式
            const dx = Math.abs(coords.x - lastTouchX);
            const dy = Math.abs(coords.y - lastTouchY);
            if (dx > 5 || dy > 5) {
                isDragging = true;
            }
            
            if (isDragging && window.ControlCommands) {
                window.ControlCommands.injectTouchEvent(deviceUDID, coords.x, coords.y, window.ControlCommands.MotionAction.MOVE, SC_POINTER_ID_MOUSE);
            }
            
            lastTouchX = coords.x;
            lastTouchY = coords.y;
        }
    });
    
    video.addEventListener('mouseup', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        
        const coords = convertToDeviceCoordinates(e.clientX, e.clientY);
        
        if (isTwoFingerMode) {
            if (window.ControlCommands) {
                // 先发送虚拟手指的 UP（与 scrcpy 一致）
                window.ControlCommands.injectTouchEvent(deviceUDID, firstFingerX, firstFingerY, window.ControlCommands.MotionAction.UP, SC_POINTER_ID_VIRTUAL_FINGER);
                // 再发送主手指的 UP
                window.ControlCommands.injectTouchEvent(deviceUDID, secondFingerX, secondFingerY, window.ControlCommands.MotionAction.UP, SC_POINTER_ID_GENERIC_FINGER);
            }
            hideTouchVisualization();
            isTwoFingerMode = false;
        } else {
            if (window.ControlCommands) {
                window.ControlCommands.injectTouchEvent(deviceUDID, coords.x, coords.y, window.ControlCommands.MotionAction.UP, SC_POINTER_ID_MOUSE);
            }
        }
        
        isDragging = false;
    });

    const touchEventOptions = { passive: false, capture: true };
    const touchTarget = video.closest('.device-video-wrapper') || video.closest('.device-video-container') || video;

    const handleTouchStart = (e) => {
        if (!e.touches || e.touches.length === 0) return;
        e.preventDefault();
        if (activeTouchId != null) return;

        const touch = e.touches[0];
        activeTouchId = touch.identifier;
        const coords = convertToDeviceCoordinates(touch.clientX, touch.clientY);

        if (isTwoFingerMode) {
            hideTouchVisualization();
            isTwoFingerMode = false;
        }

        lastTouchX = coords.x;
        lastTouchY = coords.y;
        touchStartTime = Date.now();
        isDragging = false;

        if (window.ControlCommands) {
            window.ControlCommands.injectTouchEvent(deviceUDID, coords.x, coords.y, window.ControlCommands.MotionAction.DOWN, SC_POINTER_ID_MOUSE);
        }
    };

    const handleTouchMove = (e) => {
        const touch = getPrimaryTouch(e.touches);
        if (!touch) return;
        e.preventDefault();

        const coords = convertToDeviceCoordinates(touch.clientX, touch.clientY);
        const dx = Math.abs(coords.x - lastTouchX);
        const dy = Math.abs(coords.y - lastTouchY);
        if (dx > 5 || dy > 5) {
            isDragging = true;
        }

        if (isDragging && window.ControlCommands) {
            window.ControlCommands.injectTouchEvent(deviceUDID, coords.x, coords.y, window.ControlCommands.MotionAction.MOVE, SC_POINTER_ID_MOUSE);
        }

        lastTouchX = coords.x;
        lastTouchY = coords.y;
    };

    const handleTouchEnd = (e) => {
        const touch = getPrimaryTouch(e.changedTouches);
        if (!touch && activeTouchId != null) return;
        e.preventDefault();
        if (!window.ControlCommands) return;
        endActiveTouch(touch, window.ControlCommands.MotionAction.UP);
    };

    const handleTouchCancel = (e) => {
        const touch = getPrimaryTouch(e.changedTouches);
        if (!touch && activeTouchId != null) return;
        e.preventDefault();
        if (!window.ControlCommands) return;
        endActiveTouch(touch, window.ControlCommands.MotionAction.CANCEL);
    };

    touchTarget.addEventListener('touchstart', handleTouchStart, touchEventOptions);
    touchTarget.addEventListener('touchmove', handleTouchMove, touchEventOptions);
    touchTarget.addEventListener('touchend', handleTouchEnd, touchEventOptions);
    touchTarget.addEventListener('touchcancel', handleTouchCancel, touchEventOptions);
    
    // 鼠标离开时，如果正在拖动，发送UP事件
    video.addEventListener('mouseleave', (e) => {
        if (isTwoFingerMode) {
            if (window.ControlCommands) {
                window.ControlCommands.injectTouchEvent(deviceUDID, firstFingerX, firstFingerY, window.ControlCommands.MotionAction.UP, SC_POINTER_ID_VIRTUAL_FINGER);
                window.ControlCommands.injectTouchEvent(deviceUDID, secondFingerX, secondFingerY, window.ControlCommands.MotionAction.UP, SC_POINTER_ID_GENERIC_FINGER);
            }
            hideTouchVisualization();
            isTwoFingerMode = false;
        } else if (isDragging) {
            const coords = convertToDeviceCoordinates(e.clientX, e.clientY);
            if (window.ControlCommands) {
                window.ControlCommands.injectTouchEvent(deviceUDID, coords.x, coords.y, window.ControlCommands.MotionAction.UP, SC_POINTER_ID_MOUSE);
            }
            isDragging = false;
        }
    });
    
    const modifierKeyUpHandler = (e) => {
        if ((e.key === 'Control' || e.key === 'Shift') && isTwoFingerMode) {
            if (window.ControlCommands) {
                window.ControlCommands.injectTouchEvent(deviceUDID, firstFingerX, firstFingerY, window.ControlCommands.MotionAction.UP, SC_POINTER_ID_VIRTUAL_FINGER);
                window.ControlCommands.injectTouchEvent(deviceUDID, secondFingerX, secondFingerY, window.ControlCommands.MotionAction.UP, SC_POINTER_ID_GENERIC_FINGER);
            }
            hideTouchVisualization();
            isTwoFingerMode = false;
        }
    };
    document.addEventListener('keyup', modifierKeyUpHandler);
    
    // 右键点击 -> 返回键（BACK）
    video.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (window.ControlCommands) {
            window.ControlCommands.injectKeycode(deviceUDID, window.ControlCommands.KeyCode.BACK, window.ControlCommands.MotionAction.DOWN);
            // 立即发送UP事件
            setTimeout(() => {
                window.ControlCommands.injectKeycode(deviceUDID, window.ControlCommands.KeyCode.BACK, window.ControlCommands.MotionAction.UP);
            }, 50);
        }
    });
    
    // 中键点击 -> 主页键（HOME）
    video.addEventListener('mousedown', (e) => {
        if (e.button === 1) { // 中键
            e.preventDefault();
            if (window.ControlCommands) {
                window.ControlCommands.injectKeycode(deviceUDID, window.ControlCommands.KeyCode.HOME, window.ControlCommands.MotionAction.DOWN);
                setTimeout(() => {
                    window.ControlCommands.injectKeycode(deviceUDID, window.ControlCommands.KeyCode.HOME, window.ControlCommands.MotionAction.UP);
                }, 50);
            }
        }
    });
    
    // 滚轮滚动
    video.addEventListener('wheel', (e) => {
        e.preventDefault();
        
        const coords = convertToDeviceCoordinates(e.clientX, e.clientY);
        
        // scrcpy 使用 -16 到 16 的 float 值
        // 将浏览器 delta 值转换为 scrcpy 的滚动值
        // 通常浏览器 delta 是像素值，我们需要转换为 scrcpy 的 -16 到 16 范围
        // 使用一个合理的缩放因子，比如每 10 像素对应 1 个滚动单位
        const scrollScale = 10; // 每 10 像素 = 1 滚动单位
        const hscroll = Math.max(-16, Math.min(16, -e.deltaX / scrollScale));
        const vscroll = Math.max(-16, Math.min(16, -e.deltaY / scrollScale));
        
        if (window.ControlCommands && (hscroll !== 0 || vscroll !== 0)) {
            window.ControlCommands.injectScrollEvent(deviceUDID, coords.x, coords.y, hscroll, vscroll);
        }
    });
    
    // 设置视频元素样式，使其可以接收鼠标事件
    video.style.cursor = 'pointer';
    video.style.userSelect = 'none';
    video.style.webkitUserSelect = 'none';
    video.style.touchAction = 'none';
    if (video.parentElement) {
        video.parentElement.style.touchAction = 'none';
    }
    if (touchTarget && touchTarget !== video && touchTarget !== video.parentElement) {
        touchTarget.style.touchAction = 'none';
    }
    
}

// 设置控制按钮事件；传入 deviceId（与 panel id 一致），请求用 getApiUdidForCard(wrapper)
function setupControlButtons(deviceId) {
    const safeId = safeIdFromUdid(deviceId);
    const rightPanel = document.getElementById(`control-panel-${safeId}`);
    const bottomPanel = document.getElementById(`control-panel-bottom-${safeId}`);
    [rightPanel, bottomPanel].forEach(panel => {
        if (!panel) return;
        panel.querySelectorAll('.control-btn-icon').forEach(btn => {
            if (btn.classList.contains('info-btn')) {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const apiUdid = getApiUdidFromButton(e.currentTarget);
                    if (apiUdid) fetch(`/api/device/${encodeURIComponent(apiUdid)}`).then(res => res.json()).then(device => showDeviceModal(device)).catch(err => console.error('获取设备信息失败:', err));
                };
                return;
            }
            if (btn.classList.contains('disconnect-btn')) {
                btn.removeAttribute('disabled');
                btn.style.removeProperty('opacity');
                btn.style.removeProperty('cursor');
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const apiUdid = getApiUdidFromButton(e.currentTarget);
                    if (apiUdid) handleDisconnectClick(apiUdid);
                };
                return;
            }
            const action = btn.dataset.action;
            if (action) {
                btn.onclick = function(e) {
                    e.stopPropagation();
                    e.preventDefault();
                    const apiUdid = getApiUdidFromButton(this) || deviceId;
                    if (this.hasAttribute('disabled')) {
                        showNotification('按钮被禁用，请先连接设备', apiUdid, 2000, 'warning');
                        return;
                    }
                    try {
                        handleControlAction(apiUdid, action);
                    } catch (error) {
                        console.error('[按钮点击] 执行操作失败:', error);
                        showNotification('操作执行失败: ' + error.message, apiUdid, 3000, 'error');
                    }
                };
            }
        });
    });
}

// 设置控制面板和快捷键
function setupControlPanel(deviceUDID) {
    // 控制按钮始终显示，这里只需要设置快捷键
    
    // 获取视频元素和覆盖层
    const conn = activeWebRTCConnections.get(deviceUDID);
    if (!conn || !conn.video) {
        return;
    }
    const video = conn.video;
    const deviceIdForDom = getDeviceIdForApiUdid(deviceUDID);
    const inputOverlay = document.getElementById(`input-overlay-${safeIdFromUdid(deviceIdForDom)}`);
    if (!inputOverlay) {
        console.warn(`设备 ${deviceUDID}: 未找到键盘输入覆盖层`);
        return;
    }
    
    // 设置inputOverlay使其能接收键盘事件
    inputOverlay.setAttribute('tabindex', '0');
    inputOverlay.style.outline = 'none';
    inputOverlay.style.userSelect = 'none'; // 防止文本选择

    // 确保inputOverlay可以获得焦点并接收键盘事件
    inputOverlay.focus();

    // 在mousedown时确保焦点设置到inputOverlay
    inputOverlay.addEventListener('mousedown', (e) => {
        if (e.target === inputOverlay) {
            // 设置焦点到inputOverlay
            inputOverlay.focus();
            e.preventDefault();
        }
    });

    // 鼠标事件传递到video（用于触摸控制）
    inputOverlay.addEventListener('click', (e) => {
        if (video && e.target === inputOverlay) {
            // 传递点击事件到video
            const clickEvent = new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                clientX: e.clientX,
                clientY: e.clientY,
                button: e.button,
                buttons: e.buttons
            });
            video.dispatchEvent(clickEvent);
        }
    });

    inputOverlay.addEventListener('mousemove', (e) => {
        if (video && e.target === inputOverlay) {
            const mouseEvent = new MouseEvent('mousemove', {
                bubbles: true,
                cancelable: true,
                clientX: e.clientX,
                clientY: e.clientY,
                button: e.button,
                buttons: e.buttons
            });
            video.dispatchEvent(mouseEvent);
        }
    });

    inputOverlay.addEventListener('mouseup', (e) => {
        if (video && e.target === inputOverlay) {
            const mouseEvent = new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                clientX: e.clientX,
                clientY: e.clientY,
                button: e.button,
                buttons: e.buttons
            });
            video.dispatchEvent(mouseEvent);
        }
    });

    inputOverlay.addEventListener('wheel', (e) => {
        if (video && e.target === inputOverlay) {
            e.preventDefault(); // 阻止默认滚动行为
            const wheelEvent = new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                clientX: e.clientX,
                clientY: e.clientY,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                deltaZ: e.deltaZ,
                deltaMode: e.deltaMode
            });
            video.dispatchEvent(wheelEvent);
        }
    });
    
    inputOverlay.addEventListener('contextmenu', (e) => {
        if (video && e.target === inputOverlay) {
            e.preventDefault(); // 阻止默认右键菜单
            const contextEvent = new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: e.clientX,
                clientY: e.clientY,
                button: 2
            });
            video.dispatchEvent(contextEvent);
        }
    });
    
    // 键盘输入现在通过全局监听器处理，不需要在inputOverlay上重复监听

    console.log(`设备 ${deviceUDID}: 已设置控制面板和键盘输入覆盖层`);
}


// 把按键转成发给 shell 后端的字符串（与 xterm 行为一致）
function keyEventToShellData(e, action) {
    if (action === 'press' && e.key && e.key.length === 1) {
        if (e.ctrlKey && e.key >= 'a' && e.key <= 'z') return String.fromCharCode(e.key.charCodeAt(0) - 96);
        if (e.ctrlKey && e.key === '@') return '\x00';
        return e.key;
    }
    if (action === 'down') {
        switch (e.key) {
            case 'Enter': return '\r';
            case 'Backspace': return '\x7f';
            case 'Tab': return '\t';
            default: return null;
        }
    }
    return null;
}

// 全局键盘：1) 按键目标在 .shell-window 内（xterm 的 textarea）→ 不拦截，xterm 自己收键并 onData→ws
//         2) 目标不在 shell 但 currentActiveShellWindow 已设 → 拦截并转发到该 Shell 的 ws
function setupGlobalKeyboardInput() {
    document.addEventListener('keydown', (e) => {
        if (e.target.closest('.shell-window')) return;
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)) {
            return;
        }
        if (currentActiveShellWindow && currentActiveShellWindow._shellTerminal && currentActiveShellWindow._shellWs && currentActiveShellWindow._shellWs.readyState === 1) {
            const data = keyEventToShellData(e, 'down');
            if (data) {
                e.preventDefault();
                currentActiveShellWindow._shellWs.send(data);
            }
            return;
        }
        if (!currentActiveDeviceUDID) return;
        const conn = activeWebRTCConnections.get(currentActiveDeviceUDID);
        if (!conn || !conn.dataChannel || conn.dataChannel.readyState !== 'open') return;
        handleGlobalKeyboardEvent(currentActiveDeviceUDID, e, 'down');
    });

    document.addEventListener('keyup', (e) => {
        if (e.target.closest('.shell-window')) return;
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)) {
            return;
        }
        if (currentActiveShellWindow && currentActiveShellWindow._shellTerminal) return;
        if (!currentActiveDeviceUDID) return;
        const conn = activeWebRTCConnections.get(currentActiveDeviceUDID);
        if (!conn || !conn.dataChannel || conn.dataChannel.readyState !== 'open') return;
        handleGlobalKeyboardEvent(currentActiveDeviceUDID, e, 'up');
    });

    document.addEventListener('keypress', (e) => {
        if (e.target.closest('.shell-window')) return;
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)) {
            return;
        }
        if (currentActiveShellWindow && currentActiveShellWindow._shellTerminal && currentActiveShellWindow._shellWs && currentActiveShellWindow._shellWs.readyState === 1) {
            const data = keyEventToShellData(e, 'press');
            if (data) {
                e.preventDefault();
                currentActiveShellWindow._shellWs.send(data);
            }
            return;
        }
        if (!currentActiveDeviceUDID) return;
        const conn = activeWebRTCConnections.get(currentActiveDeviceUDID);
        if (!conn || !conn.dataChannel || conn.dataChannel.readyState !== 'open') return;
        handleGlobalKeyboardEvent(currentActiveDeviceUDID, e, 'press');
    });

    window.addEventListener('blur', () => {
        if (currentActiveDeviceUDID) currentActiveDeviceUDID = null;
    });

    // 点击谁就把输入转给谁（与设备画面逻辑一致，不依赖焦点）
    document.addEventListener('click', (e) => {
        const target = e.target;

        if (target.closest('.shell-window')) {
            const shellWin = target.closest('.shell-window');
            currentActiveShellWindow = shellWin;
            currentActiveDeviceUDID = null;
            if (shellWin._shellTerminal) {
                shellWin._shellTerminal.focus();
                setTimeout(() => shellWin._shellTerminal.focus(), 0);
            }
            return;
        }

        currentActiveShellWindow = null;

        const focusMode = target.closest('#focus-mode');
        if (focusMode && focusMode.classList.contains('active') && currentFullscreenDeviceUDID) {
            currentActiveDeviceUDID = currentFullscreenDeviceUDID;
            return;
        }

        const deviceWrapper = target.closest('.device-card-wrapper');
        const videoContainer = target.closest('.device-video-container');
        const textInputPanel = target.closest('.text-input-panel');
        const deviceModal = target.closest('.device-select-modal');
        const inputOverlay = target.closest('.input-overlay, .keyboard-input-overlay');

        if (deviceWrapper || videoContainer || textInputPanel || deviceModal || inputOverlay) {
            let deviceElement = deviceWrapper || videoContainer || textInputPanel || deviceModal || inputOverlay;
            let deviceUDID = deviceElement?.dataset?.udid;
            if (deviceUDID) {
                currentActiveDeviceUDID = deviceUDID;
                return;
            }
            if (inputOverlay) {
                const udid = inputOverlay.dataset?.udid || target.closest('.device-card-wrapper')?.dataset?.udid;
                if (udid) {
                    currentActiveDeviceUDID = udid;
                    return;
                }
            }
            if (textInputPanel) {
                const udid = textInputPanel.dataset?.udid || target.closest('.device-card-wrapper')?.dataset?.udid;
                if (udid) {
                    currentActiveDeviceUDID = udid;
                    return;
                }
            }
        } else {
            if (currentActiveDeviceUDID && !currentFullscreenDeviceUDID) {
                currentActiveDeviceUDID = null;
            }
        }
    });

    console.log('全局键盘输入监听器已设置（按点击目标路由）');
}


// 处理全局键盘事件
function handleGlobalKeyboardEvent(deviceUDID, event, action) {
    if (!window.ControlCommands) {
        console.warn(`设备 ${deviceUDID}: ControlCommands不可用，无法处理键盘输入`);
        return;
    }

    const { KeyCode, MotionAction } = window.ControlCommands;

    // 对于keypress事件，发送文本
    if (action === 'press' && event.key && event.key.length === 1) {
        // 单个字符，发送文本
        window.ControlCommands.injectText(deviceUDID, event.key);
        return;
    }

    // 对于keydown/keyup，转换为keycode
    let scrcpyKeyCode = null;
    let scrcpyAction = action === 'down' ? MotionAction.DOWN : MotionAction.UP;

    // 转换常用键
    switch (event.key) {
        case 'Backspace':
        case 'Delete':
            scrcpyKeyCode = KeyCode.DEL;
            break;
        case 'Enter':
            scrcpyKeyCode = KeyCode.ENTER;
            break;
        case ' ':
            scrcpyKeyCode = KeyCode.SPACE;
            break;
        case 'Escape':
            // ESC键可能没有直接映射，暂时忽略
            return;
        case 'Tab':
            scrcpyKeyCode = KeyCode.TAB;
            break;
        default:
            // 对于其他无法映射的键，暂时忽略
            // 注意：字母数字键应该通过keypress事件处理，这里不重复处理
            return;
    }

    if (scrcpyKeyCode !== null) {
        window.ControlCommands.injectKeycode(deviceUDID, scrcpyKeyCode, scrcpyAction);
    }
}

// 执行操作的核心方法（抽取出来，支持批量调用）
function executeBackAction(deviceUDID) {
    if (!window.ControlCommands) return;
    const { KeyCode, MotionAction } = window.ControlCommands;
            window.ControlCommands.injectKeycode(deviceUDID, KeyCode.BACK, MotionAction.DOWN);
            setTimeout(() => {
                window.ControlCommands.injectKeycode(deviceUDID, KeyCode.BACK, MotionAction.UP);
            }, 50);
}

function executeHomeAction(deviceUDID) {
    if (!window.ControlCommands) return;
    const { KeyCode, MotionAction } = window.ControlCommands;
            window.ControlCommands.injectKeycode(deviceUDID, KeyCode.HOME, MotionAction.DOWN);
            setTimeout(() => {
                window.ControlCommands.injectKeycode(deviceUDID, KeyCode.HOME, MotionAction.UP);
            }, 50);
}

function executeMenuAction(deviceUDID) {
    if (!window.ControlCommands) return;
    const { KeyCode, MotionAction } = window.ControlCommands;
            window.ControlCommands.injectKeycode(deviceUDID, KeyCode.APP_SWITCH, MotionAction.DOWN);
            setTimeout(() => {
                window.ControlCommands.injectKeycode(deviceUDID, KeyCode.APP_SWITCH, MotionAction.UP);
            }, 50);
}

function executePowerAction(deviceUDID) {
    if (!window.ControlCommands) return;
    const { KeyCode, MotionAction } = window.ControlCommands;
            window.ControlCommands.injectKeycode(deviceUDID, KeyCode.POWER, MotionAction.DOWN);
            setTimeout(() => {
                window.ControlCommands.injectKeycode(deviceUDID, KeyCode.POWER, MotionAction.UP);
            }, 50);
}

// 按 deviceUDID 取该设备的控制面板（可能在卡片内或全屏时在 focus-controls/focus-header）。
// 全屏时侧栏/底栏会被移出 device-card-wrapper，所以凡是在这两个 panel 里的按钮：
// 查找或更新状态必须用本函数拿到面板再 querySelector，不要用 findWrapperByApiUdid + wrapper.querySelector，否则全屏下会失效。
function getControlPanelsForDevice(deviceUDID) {
    const deviceId = getDeviceIdForApiUdid(deviceUDID) || deviceUDID;
    const safeId = safeIdFromUdid(deviceId);
    return [
        document.getElementById(`control-panel-bottom-${safeId}`),
        document.getElementById(`control-panel-${safeId}`)
    ].filter(Boolean);
}

// 同步该设备所有面板的音频切换按钮状态（卡片/全屏下面板可能已移到 focus-header，按 id 查面板）
function syncAudioToggleButtons(deviceUDID, enabled) {
    getControlPanelsForDevice(deviceUDID).forEach(panel => {
        panel.querySelectorAll('.audio-toggle-btn').forEach(btn => {
            btn.dataset.audioEnabled = enabled ? '1' : '0';
            btn.textContent = enabled ? '🎧' : '👂';
            btn.title = enabled ? '网页播放设备声音（已开）' : '网页播放设备声音（需先投屏）';
            btn.classList.toggle('audio-on', !!enabled);
        });
    });
}

// 网页/设备声音切换：API 控制采集启停，同步静音与按钮状态（卡片/全屏共用同一套面板，按 id 查）
async function handleAudioToggleClick(deviceUDID) {
    const firstBtn = getControlPanelsForDevice(deviceUDID)
        .flatMap(p => Array.from(p.querySelectorAll('.audio-toggle-btn')))[0] || null;
    const conn = activeWebRTCConnections.get(deviceUDID);
    if (!conn || !conn.video) {
        showNotification('请先建立投屏连接', deviceUDID, 2000, 'error');
        return;
    }
    const current = firstBtn && firstBtn.dataset.audioEnabled === '1';
    const next = !current; // true = 采集且网页出声，false = 不采集仅设备出声
    try {
        const res = await fetch(`/api/device/${encodeURIComponent(deviceUDID)}/scrcpy/audio/enabled`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: next })
        });
        const data = res.ok ? await res.json().catch(() => ({})) : null;
        if (!res.ok) {
            const err = (data && data.error) || res.statusText || '请求失败';
            showNotification('音频 ' + (next ? '开启' : '关闭') + ' 失败: ' + err, deviceUDID, 3000, 'error');
            return;
        }
        syncAudioToggleButtons(deviceUDID, next);
        conn.video.muted = !next;
        if (currentFullscreenDeviceUDID === deviceUDID) {
            const focusVideo = document.getElementById('focus-video-wrapper')?.querySelector('video');
            if (focusVideo) focusVideo.muted = !next;
        }
        if (next) {
            conn.video.play().catch(() => {});
            if (currentFullscreenDeviceUDID === deviceUDID) {
                const focusVideo = document.getElementById('focus-video-wrapper')?.querySelector('video');
                if (focusVideo) focusVideo.play().catch(() => {});
            }
            setTimeout(() => {
                const c = activeWebRTCConnections.get(deviceUDID);
                if (c?.video?.srcObject && !c.video.muted) {
                    c.video.play().catch(() => {});
                }
                if (currentFullscreenDeviceUDID === deviceUDID) {
                    const focusVideo = document.getElementById('focus-video-wrapper')?.querySelector('video');
                    if (focusVideo && !focusVideo.muted) focusVideo.play().catch(() => {});
                }
            }, 300);
        }
        showNotification(next ? '声音已切到网页' : '声音已切到设备', deviceUDID, 1500, 'success');
    } catch (err) {
        console.error('音频切换请求失败:', err);
        showNotification('音频切换失败: ' + err.message, deviceUDID, 3000, 'error');
    }
}

// 处理控制按钮点击
function handleControlAction(deviceUDID, action) {
    if (!window.ControlCommands) {
        console.error(`设备 ${deviceUDID}: ControlCommands未加载`);
        return;
    }
    
    // 只操作当前设备，同步广播由 sendControlMessage 统一处理（dataChannel层）
    const { KeyCode, MotionAction } = window.ControlCommands;
    
    switch (action) {
        case 'back':
            executeBackAction(deviceUDID);
            break;
        case 'home':
            executeHomeAction(deviceUDID);
            break;
        case 'menu':
            executeMenuAction(deviceUDID);
            break;
        case 'power':
            executePowerAction(deviceUDID);
            break;
        case 'volume-up': {
            let targetDevices = [deviceUDID];
            if (syncOperationEnabled) {
                const selectedDevices = getSelectedConnectedDevices();
                const sourceDeviceId = getDeviceIdForApiUdid(deviceUDID);
                if (selectedDevices.length > 0 && selectedDevices.includes(sourceDeviceId)) {
                    targetDevices = selectedDevices.map(did => getApiUdid(did)).filter(Boolean);
                }
            }
            targetDevices.forEach(udid => {
                window.ControlCommands.injectKeycode(udid, KeyCode.VOLUME_UP, MotionAction.DOWN);
                setTimeout(() => {
                    window.ControlCommands.injectKeycode(udid, KeyCode.VOLUME_UP, MotionAction.UP);
                }, 50);
            });
            break;
        }
        case 'volume-down': {
            let targetDevices = [deviceUDID];
            if (syncOperationEnabled) {
                const selectedDevices = getSelectedConnectedDevices();
                const sourceDeviceId = getDeviceIdForApiUdid(deviceUDID);
                if (selectedDevices.length > 0 && selectedDevices.includes(sourceDeviceId)) {
                    targetDevices = selectedDevices.map(did => getApiUdid(did)).filter(Boolean);
                }
            }
            targetDevices.forEach(udid => {
                window.ControlCommands.injectKeycode(udid, KeyCode.VOLUME_DOWN, MotionAction.DOWN);
                setTimeout(() => {
                    window.ControlCommands.injectKeycode(udid, KeyCode.VOLUME_DOWN, MotionAction.UP);
                }, 50);
            });
            break;
        }
        case 'mute':
            // 发送静音键（与音量+-保持一致，用 scrcpy 按键而非 ADB）
            (async () => {
                try {
                    let targetDevices = [deviceUDID];
                    if (syncOperationEnabled) {
                        const selectedDevices = getSelectedConnectedDevices();
                        const sourceDeviceId = getDeviceIdForApiUdid(deviceUDID);
                        if (selectedDevices.length > 0 && selectedDevices.includes(sourceDeviceId)) {
                            targetDevices = selectedDevices.map(did => getApiUdid(did)).filter(Boolean);
                        }
                    }
                    targetDevices.forEach(udid => {
                        window.ControlCommands.injectKeycode(udid, KeyCode.VOLUME_MUTE, MotionAction.DOWN);
                        setTimeout(() => {
                            window.ControlCommands.injectKeycode(udid, KeyCode.VOLUME_MUTE, MotionAction.UP);
                        }, 50);
                    });
                    if (targetDevices.length > 1) {
                        showNotification(`已静音 ${targetDevices.length} 个设备`, null, 2000, 'success');
                    } else {
                        showNotification('已静音', deviceUDID, 2000, 'success');
                    }
                } catch (err) {
                    console.error('静音操作失败:', err);
                    showNotification('静音操作失败: ' + err.message, deviceUDID, 3000, 'error');
                }
            })();
            break;
        case 'rotate':
            window.ControlCommands.rotateDevice(deviceUDID);
            break;
        case 'rotate-view':
            // 只发送旋转指令到设备，不改变UI（不支持批量）
            rotateVideoView(deviceUDID);
            break;
        case 'reset-video':
            window.ControlCommands.resetVideo(deviceUDID);
            break;
        case 'notification-panel':
            window.ControlCommands.expandNotificationPanel(deviceUDID);
            break;
        case 'settings-panel':
            window.ControlCommands.expandSettingsPanel(deviceUDID);
            break;
        case 'collapse-panels':
            window.ControlCommands.collapsePanels(deviceUDID);
            break;
        case 'screen-off':
            window.ControlCommands.setDisplayPower(deviceUDID, false, '屏幕已关闭');
            break;
        case 'screen-on':
            window.ControlCommands.setDisplayPower(deviceUDID, true, '屏幕已开启');
            break;
        case 'audio-toggle':
            handleAudioToggleClick(deviceUDID);
            break;
        case 'text-input-panel':
            const deviceIdForPanel = getDeviceIdForApiUdid(deviceUDID);
            const panelSafeId = safeIdFromUdid(deviceIdForPanel);
            const panelId = `text-input-panel-${panelSafeId}`;
            let panel = document.getElementById(panelId);
            
            // 检查是否在全屏模式下
            const isFullscreen = currentFullscreenDeviceUDID === deviceUDID;
            let targetContainer = null;
            
            if (isFullscreen) {
                // 全屏模式下，使用全屏视频容器
                targetContainer = document.getElementById('focus-video-wrapper');
            } else {
                // 非全屏模式下，使用设备容器
                const conn = activeWebRTCConnections.get(deviceUDID);
                if (conn && conn.container) {
                    targetContainer = conn.container;
                }
            }
            
            if (!panel) {
                // 如果面板不存在，尝试创建它
                console.log(`设备 ${deviceUDID}: 面板不存在，尝试创建`);
                if (targetContainer) {
                    // 确保容器是相对定位
                    targetContainer.style.position = 'relative';
                    createTextInputPanel(deviceUDID, targetContainer);
                    panel = document.getElementById(panelId);
                    if (panel) {
                        console.log(`设备 ${deviceUDID}: 面板创建成功，父元素: ${panel.parentElement ? panel.parentElement.id : 'null'}`);
                    } else {
                        console.error(`设备 ${deviceUDID}: 面板创建后仍无法找到`);
                    }
                } else {
                    console.warn(`设备 ${deviceUDID}: 无法创建面板，容器不存在`);
                    return;
                }
            } else {
                console.log(`设备 ${deviceUDID}: 找到面板，父元素: ${panel.parentElement ? panel.parentElement.id : 'null'}, display: ${panel.style.display}`);
            }
            if (panel) {
                const isHidden = panel.style.display === 'none' || !panel.style.display;
                console.log(`设备 ${deviceUDID}: 面板状态 - display: ${panel.style.display}, isHidden: ${isHidden}`);
                if (isHidden) {
                    panel.style.display = 'block';
                    console.log(`设备 ${deviceUDID}: 显示文本输入面板`);
                    // 确保面板在正确的容器中
                    if (targetContainer && panel.parentElement !== targetContainer) {
                        // 面板不在正确容器中，移动
                        targetContainer.appendChild(panel);
                        // 确保容器是相对定位
                        targetContainer.style.position = 'relative';
                    }
                    const textarea = document.getElementById(`text-input-${panelSafeId}`);
                    if (textarea) {
                        textarea.focus();
                    }
                } else {
                    panel.style.display = 'none';
                    console.log(`设备 ${deviceUDID}: 隐藏文本输入面板`);
                }
            } else {
                console.error(`设备 ${deviceUDID}: 无法找到或创建文本输入面板`);
            }
            break;
        default:
            console.warn(`设备 ${deviceUDID}: 未知的控制动作: ${action}`);
    }
}

// 创建文本输入面板
function createTextInputPanel(deviceUDID, container) {
    const deviceIdForDom = getDeviceIdForApiUdid(deviceUDID);
    const panelSafeId = safeIdFromUdid(deviceIdForDom);
    let panel = document.getElementById(`text-input-panel-${panelSafeId}`);
    if (panel) return;
    if (!container) return;
    container.style.position = 'relative';
    
    panel = document.createElement('div');
    panel.id = `text-input-panel-${panelSafeId}`;
    panel.dataset.udid = deviceUDID;
    panel.className = 'text-input-panel';
    // 检查是否在全屏模式下
    const isFullscreen = currentFullscreenDeviceUDID === deviceUDID;
    panel.style.cssText = `
        position: absolute;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.9);
        border: 2px solid #3498db;
        border-radius: 12px;
        padding: 16px;
        z-index: ${isFullscreen ? '10001' : '100'};
        display: none;
        width: calc(100% - 40px);
        max-width: 600px;
        box-sizing: border-box;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    `;
    
    // 标题栏
    const header = document.createElement('div');
    header.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid #34495e;
    `;
    
    const title = document.createElement('div');
    title.textContent = '文本输入';
    title.style.cssText = `
        color: #ecf0f1;
        font-size: 16px;
        font-weight: bold;
    `;
    
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
        background: transparent;
        border: none;
        color: #ecf0f1;
        font-size: 24px;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
        line-height: 24px;
        text-align: center;
    `;
    closeBtn.onclick = () => {
        panel.style.display = 'none';
    };
    
    header.appendChild(title);
    header.appendChild(closeBtn);
    
    // 输入框
    const textarea = document.createElement('textarea');
    textarea.id = `text-input-${panelSafeId}`;
    textarea.placeholder = '输入文本或粘贴内容...';
    textarea.style.cssText = `
        width: 100%;
        min-height: 80px;
        padding: 10px;
        border: 1px solid #34495e;
        border-radius: 6px;
        background: #2c3e50;
        color: #ecf0f1;
        font-size: 14px;
        font-family: inherit;
        resize: vertical;
        box-sizing: border-box;
        margin-bottom: 12px;
    `;
    
    // 按钮容器
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = `
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
    `;
    
    // 读取设备剪贴板按钮
    const getDeviceClipboardBtn = createInputButton('📋 读取设备剪贴板', () => {
        if (!window.ControlCommands) return;
        console.log(`设备 ${deviceUDID}: GET_CLIPBOARD → scrcpy 直连读设备剪贴板（clipboard_autosync=false）`);
        window.ControlCommands.getClipboard(deviceUDID);
        const handler = (e) => {
            if (e.detail.deviceUDID === deviceUDID) {
                textarea.value = e.detail.text;
                if (e.detail.text.length === 0) {
                    alert('设备剪贴板为空或读取失败（部分 ROM/Android 版本会限制后台读剪贴板）。');
                }
                window.removeEventListener('deviceClipboard', handler);
            }
        };
        window.addEventListener('deviceClipboard', handler);
        setTimeout(() => {
            window.removeEventListener('deviceClipboard', handler);
            console.log(`设备 ${deviceUDID}: 剪贴板读取监听超时（5s）`);
        }, 5000);
    });
    
    // 读取本地剪贴板按钮
    const getLocalClipboardBtn = createInputButton('📥 读取本地剪贴板', async () => {
        try {
            const text = await navigator.clipboard.readText();
            textarea.value = text;
        } catch (err) {
            console.error('读取本地剪贴板失败:', err);
            alert('读取本地剪贴板失败，请确保已授予剪贴板权限');
        }
    });
    
    // 发送输入按钮
    const sendTextBtn = createInputButton('📤 发送输入', () => {
        const text = textarea.value.trim();
        if (!text) {
            alert('请输入要发送的文本');
            return;
        }
        if (window.ControlCommands) {
            // 一次性发送整个文本
            window.ControlCommands.injectText(deviceUDID, text);
            textarea.value = '';
            panel.style.display = 'none';
        }
    });
    
    // 发送剪贴板按钮
    const sendClipboardBtn = createInputButton('📋 发送剪贴板', () => {
        const text = textarea.value.trim();
        if (!text) {
            alert('请输入要发送的文本');
            return;
        }
        if (window.ControlCommands) {
            window.ControlCommands.setClipboard(deviceUDID, text, false);
            textarea.value = '';
            panel.style.display = 'none';
        }
    });
    
    buttonContainer.appendChild(getDeviceClipboardBtn);
    buttonContainer.appendChild(getLocalClipboardBtn);
    buttonContainer.appendChild(sendTextBtn);
    buttonContainer.appendChild(sendClipboardBtn);
    
    panel.appendChild(header);
    panel.appendChild(textarea);
    panel.appendChild(buttonContainer);
    
    container.appendChild(panel);
    
    // 已创建文本输入面板
}

// 创建按钮辅助函数
function createInputButton(text, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
        flex: 1;
        min-width: 120px;
        padding: 10px 16px;
        background: #3498db;
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        transition: background 0.2s;
    `;
    btn.onmouseover = () => {
        btn.style.background = '#2980b9';
    };
    btn.onmouseout = () => {
        btn.style.background = '#3498db';
    };
    btn.onclick = onClick;
    return btn;
}

// 在指定容器中心显示通知
function showNotificationAtPosition(message, container, duration = 2000, type = 'info') {
    // 创建通知元素
    const notification = document.createElement('div');
    notification.className = 'notification-toast';
    notification.textContent = message;
    
    // 添加动画样式（如果还没有）
    if (!document.getElementById('notification-styles')) {
        const style = document.createElement('style');
        style.id = 'notification-styles';
        style.textContent = `
            @keyframes notificationFadeIn {
                from {
                    opacity: 0;
                    transform: translate(-50%, -50%) scale(0.8);
                }
                to {
                    opacity: 1;
                    transform: translate(-50%, -50%) scale(1);
                }
            }
            @keyframes notificationFadeOut {
                from {
                    opacity: 1;
                    transform: translate(-50%, -50%) scale(1);
                }
                to {
                    opacity: 0;
                    transform: translate(-50%, -50%) scale(0.8);
                }
            }
        `;
        document.head.appendChild(style);
    }
    
    // 统一使用黑底白字
    const bgColor = 'rgba(0, 0, 0, 0.85)';
    
    if (container) {
        // 在容器中心显示
        notification.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: ${bgColor};
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            z-index: 10000;
            font-size: 14px;
            font-weight: 500;
            animation: notificationFadeIn 0.3s ease;
            backdrop-filter: blur(10px);
            pointer-events: none;
        `;
        // 确保容器是相对定位
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }
        container.appendChild(notification);
    } else {
        // 在页面右上角显示（统一风格）
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${bgColor};
            color: white;
            padding: 12px 20px;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            z-index: 10000;
            font-size: 14px;
            font-weight: 500;
            animation: notificationFadeIn 0.3s ease;
            pointer-events: none;
        `;
        document.body.appendChild(notification);
    }
    
    // 自动移除
    setTimeout(() => {
        notification.style.animation = 'notificationFadeOut 0.3s ease';
        setTimeout(() => {
            if (notification.parentElement) {
                notification.parentElement.removeChild(notification);
            }
        }, 300);
    }, duration);
}

// 发送旋转指令到设备（不改变UI）
function rotateVideoView(deviceUDID) {
    // 检查连接状态
    const conn = activeWebRTCConnections.get(deviceUDID);
    if (!conn || !conn.dataChannel || conn.dataChannel.readyState !== 'open') {
        showNotification('设备未连接，无法发送旋转指令', deviceUDID, 2000);
        return;
    }
    
    // 发送旋转指令到设备
    if (window.ControlCommands) {
        window.ControlCommands.rotateDevice(deviceUDID);
        // 显示通知
        showNotification('已发送旋转指令', deviceUDID, 2000);
    } else {
        console.warn(`设备 ${deviceUDID}: ControlCommands未加载`);
        showNotification('无法发送旋转指令：ControlCommands未加载', deviceUDID, 3000);
    }
}

// 当前全屏显示的设备UDID
let currentFullscreenDeviceUDID = null;

// 进入全屏模式（入参为 deviceId，DOM 查找用 deviceId）
function enterFullscreenMode(deviceId) {
    const focusMode = document.getElementById('focus-mode');
    const focusVideoWrapper = document.getElementById('focus-video-wrapper');
    const focusDeviceName = document.getElementById('focus-device-name');
    
    if (!focusMode || !focusVideoWrapper) {
        console.error('全屏模式元素不存在');
        return;
    }
    
    const wrapper = findWrapperByDeviceId(deviceId);
    if (!wrapper) {
        console.error(`设备 ${deviceId} 不存在`);
        return;
    }
    const videoWrapper = wrapper.querySelector(`#video-wrapper-${safeIdFromUdid(deviceId)}`);
    if (!videoWrapper) {
        console.error(`设备 ${deviceId} 的视频容器不存在`);
        return;
    }
    
    const apiUdid = getApiUdid(deviceId);
    const card = wrapper.querySelector('.device-video-card');
    const deviceName = card ? (card.dataset.deviceName || deviceId) : deviceId;
    focusDeviceName.textContent = deviceName;
    
    // 清空全屏容器
    focusVideoWrapper.innerHTML = '';
    
    // 获取视频或图片元素
    const video = videoWrapper.querySelector('video');
    const img = videoWrapper.querySelector('img');
    const mediaElement = video || img;
    
    if (video) {
        // 对于video元素，需要复制srcObject
        const fullscreenVideo = document.createElement('video');
        fullscreenVideo.autoplay = true;
        fullscreenVideo.playsInline = true;
        fullscreenVideo.muted = !!video.muted; // 全屏跟随当前视频静音状态，保持与按钮一致
        fullscreenVideo.setAttribute('webkit-playsinline', 'true');
        fullscreenVideo.setAttribute('playsinline', 'true');
        fullscreenVideo.style.width = 'auto';
        fullscreenVideo.style.height = 'auto';
        fullscreenVideo.style.maxWidth = '100%';
        fullscreenVideo.style.maxHeight = '100%';
        fullscreenVideo.style.objectFit = 'contain';
        fullscreenVideo.style.backgroundColor = '#000';
        fullscreenVideo.style.display = 'block';
        
        // 复制视频流
        if (video.srcObject) {
            fullscreenVideo.srcObject = video.srcObject;
        } else if (video.src) {
            fullscreenVideo.src = video.src;
        }
        
        focusVideoWrapper.appendChild(fullscreenVideo);
    } else if (img) {
        // 对于img元素，直接克隆
        const fullscreenImg = img.cloneNode(true);
        fullscreenImg.style.width = 'auto';
        fullscreenImg.style.height = 'auto';
        fullscreenImg.style.maxWidth = '100%';
        fullscreenImg.style.maxHeight = '100%';
        fullscreenImg.style.objectFit = 'contain';
        fullscreenImg.style.display = 'block';
        focusVideoWrapper.appendChild(fullscreenImg);
    } else {
        // 未连接时，显示占位内容（带连接按钮）
        const loadingState = videoWrapper.querySelector('.loading-state');
        
        if (loadingState && loadingState.querySelector('.start-stream-btn')) {
            // 如果有loading-state且包含连接按钮，克隆它并应用全屏样式
            const clonedState = loadingState.cloneNode(true);
            clonedState.className = 'fullscreen-placeholder';
            const connectBtn = clonedState.querySelector('.start-stream-btn');
            if (connectBtn) {
                connectBtn.onclick = (e) => {
                    e.stopPropagation();
                    handleDisconnectClick(apiUdid);
                };
            }
            focusVideoWrapper.appendChild(clonedState);
        } else {
            // 显示默认占位内容，并添加连接按钮
            const placeholder = document.createElement('div');
            placeholder.className = 'fullscreen-placeholder';
            
            const deviceIcon = document.createElement('p');
            deviceIcon.className = 'device-icon';
            deviceIcon.textContent = '📱';
            
            const deviceNameEl = document.createElement('p');
            deviceNameEl.className = 'device-name';
            deviceNameEl.textContent = deviceName;
            
            const deviceType = document.createElement('p');
            deviceType.className = 'device-type';
            deviceType.textContent = 'Android设备';
            
            const connectBtn = document.createElement('button');
            connectBtn.className = 'start-stream-btn';
            connectBtn.textContent = '🔗 连接';
            connectBtn.onclick = (e) => {
                e.stopPropagation();
                handleDisconnectClick(apiUdid);
            };
            
            placeholder.appendChild(deviceIcon);
            placeholder.appendChild(deviceNameEl);
            placeholder.appendChild(deviceType);
            placeholder.appendChild(connectBtn);
            focusVideoWrapper.appendChild(placeholder);
        }
    }
    
    createFullscreenControls(apiUdid);
    focusMode.dataset.udid = apiUdid;
    focusMode.classList.add('active');
    currentFullscreenDeviceUDID = apiUdid;
    currentActiveDeviceUDID = apiUdid;
    console.log(`进入全屏模式，设置激活设备: ${apiUdid}`);
    setTimeout(() => { focusMode.focus(); }, 100);
    updateFullscreenButtonState(apiUdid, true);
    
    // 阻止body滚动
    document.body.style.overflow = 'hidden';
}

// 退出全屏模式
function exitFullscreenMode() {
    const focusMode = document.getElementById('focus-mode');
    if (!focusMode) {
        return;
    }
    
    // 隐藏全屏模式
    focusMode.classList.remove('active');
    
    // 移除全屏模式的data-udid属性
    delete focusMode.dataset.udid;
    
    // 更新全屏按钮状态
    const previousDeviceUDID = currentFullscreenDeviceUDID;
    currentFullscreenDeviceUDID = null;
    if (previousDeviceUDID) {
        updateFullscreenButtonState(previousDeviceUDID, false);
    }
    
    // 退出全屏时不清空激活设备，保持键盘输入到最后一个全屏设备
    // 如果需要清空，可以取消下面的注释
    // currentActiveDeviceUDID = null;
    
    // 恢复body滚动
    document.body.style.overflow = '';
    
    // 先把侧栏移回卡片再清空，避免销毁 DOM
    if (previousDeviceUDID) {
        restoreFullscreenPanelsToCard(previousDeviceUDID);
    }
    
    const focusVideoWrapper = document.getElementById('focus-video-wrapper');
    if (focusVideoWrapper) {
        focusVideoWrapper.innerHTML = '';
    }
    
    const focusControls = document.getElementById('focus-controls');
    if (focusControls) {
        focusControls.innerHTML = '';
    }
}

// 更新全屏按钮状态
function updateFullscreenButtonState(deviceUDID, isFullscreen) {
    const wrapper = document.querySelector(`.device-card-wrapper[data-udid="${CSS.escape(deviceUDID)}"]`);
    if (!wrapper) {
        return;
    }
    
    // 全屏按钮现在在card的header中，从wrapper或card中查找
    const card = wrapper.querySelector('.device-video-card');
    const fullscreenBtn = card ? card.querySelector('.fullscreen-btn') : wrapper.querySelector('.fullscreen-btn');
    if (!fullscreenBtn) {
        return;
    }
    
    if (isFullscreen) {
        fullscreenBtn.textContent = '⛶';
        fullscreenBtn.title = '退出全屏';
        fullscreenBtn.style.background = '#2ecc71';
    } else {
        fullscreenBtn.textContent = '⛶';
        fullscreenBtn.title = '全屏放大';
        fullscreenBtn.style.background = 'rgba(255, 255, 255, 0.2)';
    }
}

// 更新全屏界面的视频显示（连接成功后调用）
function updateFullscreenVideo(deviceUDID, videoElement) {
    if (currentFullscreenDeviceUDID !== deviceUDID) {
        return; // 不是当前全屏设备，不更新
    }
    
    const focusVideoWrapper = document.getElementById('focus-video-wrapper');
    if (!focusVideoWrapper) {
        return;
    }
    
    // 清空全屏容器
    focusVideoWrapper.innerHTML = '';
    
    // 克隆视频元素到全屏容器
    const fullscreenVideo = document.createElement('video');
    fullscreenVideo.autoplay = true;
    fullscreenVideo.playsInline = true;
    fullscreenVideo.muted = !!videoElement.muted; // 全屏跟随当前视频静音状态，保持与按钮一致
    fullscreenVideo.setAttribute('webkit-playsinline', 'true');
    fullscreenVideo.setAttribute('playsinline', 'true');
    fullscreenVideo.style.width = 'auto';
    fullscreenVideo.style.height = 'auto';
    fullscreenVideo.style.maxWidth = '100%';
    fullscreenVideo.style.maxHeight = '100%';
    fullscreenVideo.style.objectFit = 'contain';
    fullscreenVideo.style.backgroundColor = '#000';
    fullscreenVideo.style.display = 'block';
    
    // 复制视频流
    if (videoElement.srcObject) {
        fullscreenVideo.srcObject = videoElement.srcObject;
    } else if (videoElement.src) {
        fullscreenVideo.src = videoElement.src;
    }
    
    focusVideoWrapper.appendChild(fullscreenVideo);
    
    // 设置视频鼠标事件（用于触摸控制）
    if (activeWebRTCConnections.has(deviceUDID)) {
        setTimeout(() => {
            setupVideoMouseEvents(deviceUDID, fullscreenVideo);
        }, 500);
    }
    
    // 重新创建全屏控制栏以更新按钮状态
    createFullscreenControls(deviceUDID);
}

// 更新全屏界面的图片显示
function updateFullscreenImage(deviceUDID, imgElement) {
    if (currentFullscreenDeviceUDID !== deviceUDID) {
        return; // 不是当前全屏设备，不更新
    }
    
    const focusVideoWrapper = document.getElementById('focus-video-wrapper');
    if (!focusVideoWrapper) {
        return;
    }
    
    // 清空全屏容器
    focusVideoWrapper.innerHTML = '';
    
    // 克隆图片元素到全屏容器
    const fullscreenImg = imgElement.cloneNode(true);
    fullscreenImg.style.width = 'auto';
    fullscreenImg.style.height = 'auto';
    fullscreenImg.style.maxWidth = '100%';
    fullscreenImg.style.maxHeight = '100%';
    fullscreenImg.style.objectFit = 'contain';
    fullscreenImg.style.display = 'block';
    
    focusVideoWrapper.appendChild(fullscreenImg);
}

// 更新全屏界面断开连接后的UI（显示连接按钮）
function updateFullscreenDisconnectedUI(deviceUDID) {
    if (currentFullscreenDeviceUDID !== deviceUDID) {
        return; // 不是当前全屏设备，不更新
    }
    
    const focusVideoWrapper = document.getElementById('focus-video-wrapper');
    if (!focusVideoWrapper) {
        return;
    }
    
    // 获取设备信息
    const wrapper = document.querySelector(`.device-card-wrapper[data-udid="${CSS.escape(deviceUDID)}"]`);
    const card = wrapper ? wrapper.querySelector('.device-video-card') : null;
    const deviceName = card ? (card.dataset.deviceName || deviceUDID) : deviceUDID;
    // 清空全屏容器
    focusVideoWrapper.innerHTML = '';
    
    // 创建占位内容，带连接按钮
    const placeholder = document.createElement('div');
    placeholder.className = 'fullscreen-placeholder';
    
    const deviceIcon = document.createElement('p');
    deviceIcon.className = 'device-icon';
    deviceIcon.textContent = '📱';
    
    const deviceNameEl = document.createElement('p');
    deviceNameEl.className = 'device-name';
    deviceNameEl.textContent = deviceName;
    
    const deviceType = document.createElement('p');
    deviceType.className = 'device-type';
    deviceType.textContent = 'Android设备';
    
    const connectBtn = document.createElement('button');
    connectBtn.className = 'start-stream-btn';
    connectBtn.textContent = '🔗 连接';
    connectBtn.onclick = (e) => {
        e.stopPropagation();
        handleDisconnectClick(deviceUDID);
    };
    
    placeholder.appendChild(deviceIcon);
    placeholder.appendChild(deviceNameEl);
    placeholder.appendChild(deviceType);
    placeholder.appendChild(connectBtn);
    
    focusVideoWrapper.appendChild(placeholder);
    
    // 重新创建全屏控制栏以更新按钮状态
    createFullscreenControls(deviceUDID);
}

// 全屏：底部只放三键居中；侧栏 device-control-panel 移到 focus-header 顶部显示（顶栏只保留当前设备一套）
function createFullscreenControls(deviceUDID) {
    const focusControls = document.getElementById('focus-controls');
    const focusHeader = document.querySelector('.focus-header');
    if (!focusControls || !focusHeader) return;
    
    const deviceIdForDom = getDeviceIdForApiUdid(deviceUDID);
    const safeId = safeIdFromUdid(deviceIdForDom);
    const bottomPanel = document.getElementById(`control-panel-bottom-${safeId}`);
    const rightPanel = document.getElementById(`control-panel-${safeId}`);
    if (!bottomPanel && !rightPanel) return;
    
    // 顶栏只保留一套：先把 focus-header 里所有 device-control-panel 都移回各自 wrapper，再只插入当前设备的
    var exitBtn = document.getElementById('exit-focus-mode');
    focusHeader.querySelectorAll('.device-control-panel').forEach(function (panel) {
        var sid = panel.id && panel.id.replace(/^control-panel-/, '');
        if (!sid) return;
        document.querySelectorAll('.device-card-wrapper').forEach(function (w) {
            var did = w.dataset.deviceId;
            if (did && safeIdFromUdid(did) === sid) {
                w.appendChild(panel);
            }
        });
    });
    if (rightPanel && exitBtn) {
        focusHeader.insertBefore(rightPanel, exitBtn);
    }
    
    focusControls.innerHTML = '';
    if (bottomPanel) focusControls.appendChild(bottomPanel);
    
    const focusVideoWrapper = document.getElementById('focus-video-wrapper');
    const fullscreenVideo = focusVideoWrapper?.querySelector('video');
    if (fullscreenVideo && activeWebRTCConnections.has(deviceUDID)) {
        setTimeout(() => setupVideoMouseEvents(deviceUDID, fullscreenVideo), 500);
    }
}

// 退出全屏时把侧栏从 focus-controls 移回卡片
function restoreFullscreenPanelsToCard(apiUdid) {
    const wrapper = findWrapperByApiUdid(apiUdid);
    if (!wrapper) return;
    const deviceId = wrapper.dataset.deviceId || apiUdid;
    const safeId = safeIdFromUdid(deviceId);
    const card = wrapper.querySelector('.device-video-card');
    const container = card?.querySelector('.device-video-container');
    const bottomPanel = document.getElementById(`control-panel-bottom-${safeId}`);
    const rightPanel = document.getElementById(`control-panel-${safeId}`);
    if (container && bottomPanel && bottomPanel.parentElement?.id === 'focus-controls') {
        container.appendChild(bottomPanel);
    }
    if (rightPanel && rightPanel.parentElement?.classList?.contains('focus-header')) {
        wrapper.appendChild(rightPanel);
    }
}

// 初始化全屏模式事件
function initFullscreenMode() {
    const focusMode = document.getElementById('focus-mode');
    const exitBtn = document.getElementById('exit-focus-mode');
    
    if (!focusMode || !exitBtn) {
        return;
    }
    
    // 点击退出按钮退出全屏
    exitBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        exitFullscreenMode();
    });
    
    // 点击全屏区域（非视频区域）也可以退出全屏
    focusMode.addEventListener('click', (e) => {
        // 如果点击的是退出按钮，不处理（由退出按钮自己的事件处理）
        if (e.target === exitBtn || exitBtn.contains(e.target)) {
            return;
        }
        
        // 如果点击的是确认对话框（遮罩层或对话框内容），不退出全屏
        const confirmDialogOverlay = document.querySelector('[id^="confirm-dialog-overlay-"]');
        if (confirmDialogOverlay && confirmDialogOverlay.contains(e.target)) {
            return;
        }
        
        // 如果点击的是设备信息面板，不退出全屏
        const deviceInfoPanel = document.querySelector('.device-info-panel');
        if (deviceInfoPanel && deviceInfoPanel.contains(e.target)) {
            return;
        }
        
        // 如果点击的是视频容器内部，设置激活设备（用于键盘输入）
        const focusVideoWrapper = document.getElementById('focus-video-wrapper');
        if (focusVideoWrapper && focusVideoWrapper.contains(e.target)) {
            // 点击视频区域时，设置当前激活设备
            if (currentFullscreenDeviceUDID) {
                currentActiveDeviceUDID = currentFullscreenDeviceUDID;
                console.log(`全屏模式下点击视频，激活设备: ${currentFullscreenDeviceUDID}`);
            }
            return;
        }
        
        // 如果点击的是控制按钮栏，不退出
        const focusControls = document.getElementById('focus-controls');
        if (focusControls && focusControls.contains(e.target)) {
            return;
        }
        
        // 如果点击的是header区域（除了退出按钮），不退出
        const focusHeader = document.querySelector('.focus-header');
        if (focusHeader && focusHeader.contains(e.target) && e.target !== exitBtn && !exitBtn.contains(e.target)) {
            return;
        }
        // 收窄：仅退出按钮 + ESC 可退出全屏，点击其它区域不再退出（避免手势/误触）
    });
    
    // ESC键退出全屏
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && currentFullscreenDeviceUDID) {
            exitFullscreenMode();
        }
    });
}

// 给视频容器添加点击事件监听器（仅用于设置激活设备，不进入全屏）
function setupVideoClickHandler(deviceUDID, videoWrapper) {
    if (!videoWrapper) {
        return;
    }
    
    // 移除旧的事件监听器（如果存在）
    const oldHandler = videoWrapper._clickHandler;
    if (oldHandler) {
        videoWrapper.removeEventListener('click', oldHandler);
    }
    
    // 添加新的点击事件监听器（仅用于设置激活设备，不进入全屏）
    const clickHandler = (e) => {
        // 如果点击的是按钮或其他交互元素，不处理
        if (e.target.closest('button') || e.target.closest('.control-btn-icon')) {
            return;
        }
        
        // 只设置当前激活设备（用于键盘输入），不进入全屏
        currentActiveDeviceUDID = deviceUDID;
        console.log(`点击视频区域，激活设备: ${deviceUDID}`);
    };
    
    videoWrapper.addEventListener('click', clickHandler);
    videoWrapper._clickHandler = clickHandler;
    
    // 移除鼠标样式提示（因为不再用于进入全屏）
    videoWrapper.style.cursor = '';
}
