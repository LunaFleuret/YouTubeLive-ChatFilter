/**
 * YouTube Live Chat Filter - Popup Script
 * 
 * 役割:
 * - タブ切り替え（フィルタ / 環境設定）
 * - 自分のチャンネル登録UI
 * - フィルタ ON/OFF トグル
 * - ホワイトリスト / ブラックリストのモード切り替え
 * - 直近発言者・許可ユーザー・ブロックユーザー管理
 * - 設定管理
 */

// ========================================
// DOM要素
// ========================================

const elements = {
    // タブ
    tabFilterBtn: document.getElementById('tabFilterBtn'),
    tabSettingsBtn: document.getElementById('tabSettingsBtn'),
    viewFilter: document.getElementById('viewFilter'),
    viewSettings: document.getElementById('viewSettings'),

    // 自分のチャンネル
    selfSection: document.getElementById('self-section'),
    selfNotRegistered: document.getElementById('self-not-registered'),
    selfRegistered: document.getElementById('self-registered'),
    selfInput: document.getElementById('self-input'),
    selfSaveBtn: document.getElementById('self-save-btn'),
    selfChannelId: document.getElementById('self-channel-id'),
    selfChangeBtn: document.getElementById('self-change-btn'),

    // ステータス
    statusSection: document.getElementById('status-section'),
    statusInvalid: document.getElementById('status-invalid'),
    statusReplay: document.getElementById('status-replay'),
    statusNoSelf: document.getElementById('status-no-self'),
    statusNoOwner: document.getElementById('status-no-owner'),
    statusReason: document.getElementById('status-reason'),

    // フィルタ
    filterSection: document.getElementById('filter-section'),
    filterToggle: document.getElementById('filter-toggle'),
    toggleLabel: document.getElementById('toggle-label'),
    filterModeIndicator: document.getElementById('filter-mode-indicator'),
    ownerChannelId: document.getElementById('owner-channel-id'),

    // 発言者
    speakersSection: document.getElementById('speakers-section'),
    speakersList: document.getElementById('speakers-list'),

    // 許可ユーザー (ホワイトリスト)
    allowedSection: document.getElementById('allowed-section'),
    allowedList: document.getElementById('allowed-list'),

    // ブロックユーザー (ブラックリスト)
    blockedSection: document.getElementById('blocked-section'),
    blockedList: document.getElementById('blocked-list'),

    // 設定
    settingFilterMode: document.getElementById('setting-filter-mode'),
    moderatorSettingItem: document.getElementById('moderator-setting-item'),
    settingModerator: document.getElementById('setting-moderator'),
    settingStartup: document.getElementById('setting-startup'),

    // ヘッダー
    appVersion: document.getElementById('app-version')
};

// ========================================
// 状態
// ========================================

let currentTab = null;
let contentScriptStatus = null;
let currentFilterMode = 'whitelist';

// ========================================
// ユーティリティ
// ========================================

function showElement(el) {
    if (el) el.classList.remove('hidden');
}

function hideElement(el) {
    if (el) el.classList.add('hidden');
}

function setLoading(isLoading) {
    document.body.classList.toggle('loading', isLoading);
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * タブ切り替え
 */
function switchTab(target) {
    if (target === 'filter') {
        elements.tabFilterBtn.classList.add('active');
        elements.tabSettingsBtn.classList.remove('active');
        showElement(elements.viewFilter);
        hideElement(elements.viewSettings);
    } else {
        elements.tabSettingsBtn.classList.add('active');
        elements.tabFilterBtn.classList.remove('active');
        showElement(elements.viewSettings);
        hideElement(elements.viewFilter);
    }
}

/**
 * content scriptにメッセージを送信
 */
async function sendToContentScript(message) {
    if (!currentTab?.id) {
        return null;
    }

    try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: currentTab.id });

        if (!frames || frames.length === 0) {
            return await chrome.tabs.sendMessage(currentTab.id, message);
        }

        const liveChatFrame = frames.find(f => f.url && (f.url.includes('youtube.com/live_chat') || f.url.includes('youtube.com/live_chat_replay')));

        if (liveChatFrame) {
            return await chrome.tabs.sendMessage(currentTab.id, message, { frameId: liveChatFrame.frameId });
        }

        return await chrome.tabs.sendMessage(currentTab.id, message);
    } catch (e) {
        console.error('Content script通信エラー:', e);
        return null;
    }
}

/**
 * backgroundにメッセージを送信
 */
async function sendToBackground(message) {
    try {
        return await chrome.runtime.sendMessage(message);
    } catch (e) {
        console.error('Background通信エラー:', e);
        return null;
    }
}

// ========================================
// 自分のチャンネル管理
// ========================================

async function loadSelfChannel() {
    const result = await chrome.storage.local.get('self');
    const selfData = result.self;

    if (selfData?.channelId) {
        showSelfRegistered(selfData.channelId);
    } else {
        showSelfNotRegistered();
    }
}

function showSelfRegistered(channelId) {
    hideElement(elements.selfNotRegistered);
    showElement(elements.selfRegistered);
    elements.selfChannelId.textContent = channelId;
}

function showSelfNotRegistered() {
    showElement(elements.selfNotRegistered);
    hideElement(elements.selfRegistered);
    elements.selfInput.value = '';
}

async function saveSelfChannel() {
    const input = elements.selfInput.value.trim();
    if (!input) {
        alert('チャンネルを入力してください');
        return;
    }

    setLoading(true);
    elements.selfSaveBtn.disabled = true;

    try {
        const response = await sendToBackground({
            type: 'RESOLVE_CHANNEL_ID',
            input
        });

        if (response?.success && response.channelId) {
            await chrome.storage.local.set({
                self: { channelId: response.channelId }
            });
            showSelfRegistered(response.channelId);

            await updateStatus();
        } else {
            alert('チャンネルIDを解決できませんでした。\nURL、@handle、または UCxxxx 形式で入力してください。');
        }
    } catch (e) {
        console.error('保存エラー:', e);
        alert('エラーが発生しました');
    } finally {
        setLoading(false);
        elements.selfSaveBtn.disabled = false;
    }
}

// ========================================
// 設定管理
// ========================================

async function loadSettings() {
    const result = await chrome.storage.local.get('settings');
    const settings = result.settings || {};

    currentFilterMode = settings.filterMode || 'whitelist';
    elements.settingFilterMode.value = currentFilterMode;
    elements.settingModerator.checked = settings.treatModeratorAsStreamer || false;
    elements.settingStartup.value = settings.startupBehavior || 'alwaysOff';

    applyFilterModeUI();
}

function applyFilterModeUI() {
    if (currentFilterMode === 'blacklist') {
        elements.toggleLabel.textContent = '指定ユーザーを非表示';
        if (elements.filterModeIndicator) elements.filterModeIndicator.textContent = 'BLACKLIST';
        hideElement(elements.allowedSection);
        showElement(elements.blockedSection);
        hideElement(elements.moderatorSettingItem);
    } else {
        elements.toggleLabel.textContent = '自分以外を非表示';
        if (elements.filterModeIndicator) elements.filterModeIndicator.textContent = 'WHITELIST';
        showElement(elements.allowedSection);
        hideElement(elements.blockedSection);
        showElement(elements.moderatorSettingItem);
    }
}

async function saveSettings() {
    currentFilterMode = elements.settingFilterMode.value;
    applyFilterModeUI();

    const settings = {
        filterMode: currentFilterMode,
        treatModeratorAsStreamer: elements.settingModerator.checked,
        startupBehavior: elements.settingStartup.value,
        debug: false
    };

    await chrome.storage.local.set({ settings });

    await sendToContentScript({
        type: 'UPDATE_SETTINGS',
        ...settings
    });

    if (contentScriptStatus) {
        renderAllowedUsers(contentScriptStatus.allowedUsers || []);
        renderBlockedUsers(contentScriptStatus.blockedUsers || []);
        await loadRecentSpeakers();
    }
}

// ========================================
// 状態更新
// ========================================

async function updateStatus() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    const isLiveChatPage = tab?.url?.includes('youtube.com/live_chat');
    const isWatchPage = tab?.url?.includes('youtube.com/watch');

    if (!isLiveChatPage && !isWatchPage) {
        showInvalidPage('YouTubeの配信ページを開いてください');
        return;
    }

    if (isWatchPage) {
        try {
            const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
            const hasLiveChatFrame = frames?.some(f => f.url && (f.url.includes('youtube.com/live_chat') || f.url.includes('youtube.com/live_chat_replay')));

            if (!hasLiveChatFrame) {
                showInvalidPage('この配信にはチャットがありません');
                return;
            }
        } catch (e) {
            console.error('フレーム取得エラー:', e);
            showInvalidPage('ページ情報を取得できませんでした');
            return;
        }
    }

    contentScriptStatus = await sendToContentScript({ type: 'GET_STATUS' });

    if (!contentScriptStatus) {
        showInvalidPage('ページを再読み込みしてください');
        return;
    }

    // 自分のチャンネル未登録（ホワイトリストモード時のみ警告）
    if (currentFilterMode === 'whitelist' && !contentScriptStatus.selfChannelId) {
        showNoSelf();
        return;
    }

    showFilterUI();
}

function showInvalidPage(reason) {
    hideElement(elements.filterSection);
    hideElement(elements.speakersSection);
    hideElement(elements.allowedSection);
    hideElement(elements.blockedSection);

    showElement(elements.statusInvalid);
    elements.statusReason.textContent = reason;

    hideElement(elements.statusReplay);
    hideElement(elements.statusNoSelf);
    hideElement(elements.statusNoOwner);
}

function showNoSelf() {
    hideElement(elements.filterSection);
    hideElement(elements.speakersSection);
    hideElement(elements.allowedSection);
    hideElement(elements.blockedSection);

    hideElement(elements.statusInvalid);
    hideElement(elements.statusReplay);
    showElement(elements.statusNoSelf);
    hideElement(elements.statusNoOwner);
}

function showFilterUI() {
    hideElement(elements.statusInvalid);
    hideElement(elements.statusNoSelf);
    hideElement(elements.statusNoOwner);

    if (contentScriptStatus?.isReplayPage) {
        showElement(elements.statusReplay);
    } else {
        hideElement(elements.statusReplay);
    }

    showElement(elements.filterSection);
    showElement(elements.speakersSection);

    applyFilterModeUI();

    elements.filterToggle.checked = contentScriptStatus.filterEnabled;
    elements.ownerChannelId.textContent = contentScriptStatus.ownerChannelId || '自動判定中';

    renderAllowedUsers(contentScriptStatus.allowedUsers || []);
    renderBlockedUsers(contentScriptStatus.blockedUsers || []);

    loadRecentSpeakers();
}

// ========================================
// 直近発言者
// ========================================

async function loadRecentSpeakers() {
    const response = await sendToContentScript({ type: 'GET_RECENT_SPEAKERS' });

    if (response?.success && response.speakers) {
        renderRecentSpeakers(response.speakers);
    } else {
        elements.speakersList.innerHTML = '<p class="empty-message">発言者がいません</p>';
    }
}

function renderRecentSpeakers(speakers) {
    if (!speakers || speakers.length === 0) {
        elements.speakersList.innerHTML = '<p class="empty-message">発言者がいません</p>';
        return;
    }

    const allowedIds = new Set((contentScriptStatus?.allowedUsers || []).map(u => u.channelId));
    const blockedIds = new Set((contentScriptStatus?.blockedUsers || []).map(u => u.channelId));

    const filtered = speakers.filter(s =>
        s.channelId !== contentScriptStatus?.selfChannelId &&
        s.channelId !== contentScriptStatus?.ownerChannelId &&
        !allowedIds.has(s.channelId) &&
        !blockedIds.has(s.channelId)
    );

    if (filtered.length === 0) {
        elements.speakersList.innerHTML = '<p class="empty-message">対象の発言者がいません</p>';
        return;
    }

    const isBlacklist = currentFilterMode === 'blacklist';
    const actionBtnClass = isBlacklist ? 'btn-block' : 'btn-add';
    const actionBtnText = isBlacklist ? 'ブロック' : '+ 許可';
    const actionType = isBlacklist ? 'block' : 'add';

    elements.speakersList.innerHTML = filtered.map(speaker => `
    <div class="user-item" data-channel-id="${escapeHtml(speaker.channelId)}">
      <div class="user-item-info">
        ${speaker.avatarUrl ? `<img class="user-avatar" src="${escapeHtml(speaker.avatarUrl)}" alt="">` : '<div class="user-avatar"></div>'}
        <span class="user-name" title="${escapeHtml(speaker.channelId)}">${escapeHtml(speaker.displayName)}</span>
      </div>
      <button class="${actionBtnClass}" data-action="${actionType}">${actionBtnText}</button>
    </div>
  `).join('');

    elements.speakersList.querySelectorAll(`[data-action="${actionType}"]`).forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const item = e.target.closest('.user-item');
            const channelId = item.dataset.channelId;
            const displayName = item.querySelector('.user-name').textContent;
            const avatarImg = item.querySelector('.user-avatar');
            const avatarUrl = avatarImg?.src || '';

            if (isBlacklist) {
                await addBlockedUser({ channelId, displayName, avatarUrl });
            } else {
                await addAllowedUser({ channelId, displayName, avatarUrl });
            }
        });
    });
}

// ========================================
// 許可ユーザー (ホワイトリスト)
// ========================================

function renderAllowedUsers(users) {
    if (!users || users.length === 0) {
        elements.allowedList.innerHTML = '<p class="empty-message">許可ユーザーがいません</p>';
        return;
    }

    elements.allowedList.innerHTML = users.map(user => `
    <div class="user-item" data-channel-id="${escapeHtml(user.channelId)}">
      <div class="user-item-info">
        ${user.avatarUrl ? `<img class="user-avatar" src="${escapeHtml(user.avatarUrl)}" alt="">` : '<div class="user-avatar"></div>'}
        <span class="user-name" title="${escapeHtml(user.channelId)}">${escapeHtml(user.displayName)}</span>
      </div>
      <button class="btn-remove" data-action="remove-allowed">解除</button>
    </div>
  `).join('');

    elements.allowedList.querySelectorAll('[data-action="remove-allowed"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const item = e.target.closest('.user-item');
            const channelId = item.dataset.channelId;
            await removeAllowedUser(channelId);
        });
    });
}

async function addAllowedUser(user) {
    setLoading(true);

    const response = await sendToContentScript({
        type: 'ADD_ALLOWED_USER',
        user
    });

    if (response?.success) {
        if (!contentScriptStatus.allowedUsers) {
            contentScriptStatus.allowedUsers = [];
        }
        contentScriptStatus.allowedUsers.push(user);
        renderAllowedUsers(contentScriptStatus.allowedUsers);
        await loadRecentSpeakers();
    }

    setLoading(false);
}

async function removeAllowedUser(channelId) {
    setLoading(true);

    const response = await sendToContentScript({
        type: 'REMOVE_ALLOWED_USER',
        channelId
    });

    if (response?.success) {
        contentScriptStatus.allowedUsers = (contentScriptStatus.allowedUsers || [])
            .filter(u => u.channelId !== channelId);
        renderAllowedUsers(contentScriptStatus.allowedUsers);
        await loadRecentSpeakers();
    }

    setLoading(false);
}

// ========================================
// ブロックユーザー (ブラックリスト)
// ========================================

function renderBlockedUsers(users) {
    if (!users || users.length === 0) {
        elements.blockedList.innerHTML = '<p class="empty-message">ブロック中のユーザーはいません</p>';
        return;
    }

    elements.blockedList.innerHTML = users.map(user => `
    <div class="user-item" data-channel-id="${escapeHtml(user.channelId)}">
      <div class="user-item-info">
        ${user.avatarUrl ? `<img class="user-avatar" src="${escapeHtml(user.avatarUrl)}" alt="">` : '<div class="user-avatar"></div>'}
        <span class="user-name" title="${escapeHtml(user.channelId)}">${escapeHtml(user.displayName)}</span>
      </div>
      <button class="btn-remove" data-action="remove-blocked">解除</button>
    </div>
  `).join('');

    elements.blockedList.querySelectorAll('[data-action="remove-blocked"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const item = e.target.closest('.user-item');
            const channelId = item.dataset.channelId;
            await removeBlockedUser(channelId);
        });
    });
}

async function addBlockedUser(user) {
    setLoading(true);

    const response = await sendToContentScript({
        type: 'ADD_BLOCKED_USER',
        user
    });

    if (response?.success) {
        if (!contentScriptStatus.blockedUsers) {
            contentScriptStatus.blockedUsers = [];
        }
        contentScriptStatus.blockedUsers.push(user);
        renderBlockedUsers(contentScriptStatus.blockedUsers);
        await loadRecentSpeakers();
    }

    setLoading(false);
}

async function removeBlockedUser(channelId) {
    setLoading(true);

    const response = await sendToContentScript({
        type: 'REMOVE_BLOCKED_USER',
        channelId
    });

    if (response?.success) {
        contentScriptStatus.blockedUsers = (contentScriptStatus.blockedUsers || [])
            .filter(u => u.channelId !== channelId);
        renderBlockedUsers(contentScriptStatus.blockedUsers);
        await loadRecentSpeakers();
    }

    setLoading(false);
}

// ========================================
// フィルタ制御
// ========================================

async function toggleFilter(enabled) {
    setLoading(true);

    const response = await sendToContentScript({
        type: enabled ? 'ENABLE_FILTER' : 'DISABLE_FILTER'
    });

    if (!response?.success) {
        elements.filterToggle.checked = !enabled;

        if (response?.error === 'SELF_NOT_SET' && currentFilterMode === 'whitelist') {
            alert('「環境設定」タブから自分のチャンネルを登録してください');
            switchTab('settings');
        } else if (response?.error === 'OWNER_UNKNOWN') {
            alert('配信者を検出できませんでした');
        }
    } else {
        contentScriptStatus.filterEnabled = enabled;
    }

    setLoading(false);
}

// ========================================
// イベントリスナー
// ========================================

function setupEventListeners() {
    // タブ切り替え
    elements.tabFilterBtn.addEventListener('click', () => switchTab('filter'));
    elements.tabSettingsBtn.addEventListener('click', () => switchTab('settings'));

    // 自分のチャンネル保存
    elements.selfSaveBtn.addEventListener('click', saveSelfChannel);

    elements.selfInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            saveSelfChannel();
        }
    });

    elements.selfChangeBtn.addEventListener('click', showSelfNotRegistered);

    // フィルタトグル
    elements.filterToggle.addEventListener('change', (e) => {
        toggleFilter(e.target.checked);
    });

    // 設定変更
    elements.settingFilterMode.addEventListener('change', saveSettings);
    elements.settingModerator.addEventListener('change', saveSettings);
    elements.settingStartup.addEventListener('change', saveSettings);
}

// ========================================
// 初期化
// ========================================

async function initialize() {
    try {
        const manifest = chrome.runtime.getManifest();
        if (elements.appVersion && manifest?.version) {
            elements.appVersion.textContent = 'v' + manifest.version;
        }
    } catch (e) {
        // 無視
    }

    setupEventListeners();
    await loadSelfChannel();
    await loadSettings();
    await updateStatus();
}

initialize();
