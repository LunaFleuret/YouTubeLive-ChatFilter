/**
 * YouTube Live Chat Filter - Content Script
 * 
 * 役割:
 * - MutationObserver でチャットを監視
 * - ホワイトリスト / ブラックリスト方式に基づいてコメントを非表示/復元
 * - 直近の発言者・許可/ブロックユーザーを記録
 * - スクロール位置の追従補助
 */

(function () {
    'use strict';

    if (!window.location.pathname.includes('live_chat')) {
        return;
    }

    // ========================================
    // 定数・設定
    // ========================================

    const MAX_RECENT_SPEAKERS = 50;

    // 常に表示するレンダラータグ（フィルタ対象外）
    const ALWAYS_VISIBLE_TAGS = [
        'yt-live-chat-banner-manager',
        'yt-live-chat-pinned-message-renderer',
        'yt-live-chat-banner-renderer',
        'yt-live-chat-poll-renderer',
        'yt-live-chat-viewer-engagement-message-renderer',
        'yt-live-chat-mode-change-message-renderer',
        'yt-live-chat-restricted-participation-renderer',
        'yt-live-chat-ticker-renderer',
        'yt-live-chat-ticker-paid-message-item-renderer',
        'yt-live-chat-ticker-paid-sticker-item-renderer',
        'yt-live-chat-ticker-sponsor-item-renderer'
    ];

    // チャットコメントのレンダラータグ
    const CHAT_MESSAGE_TAGS = [
        'yt-live-chat-text-message-renderer',
        'yt-live-chat-paid-message-renderer',
        'yt-live-chat-paid-sticker-renderer',
        'yt-live-chat-membership-item-renderer',
        'yt-live-chat-legacy-paid-message-renderer'
    ];

    // モデレーター・オーナーバッジのセレクタ
    const MODERATOR_BADGE_SELECTOR = 'yt-live-chat-author-badge-renderer[type="moderator"]';
    const OWNER_BADGE_SELECTOR = 'yt-live-chat-author-badge-renderer[type="owner"]';

    // ========================================
    // 状態管理
    // ========================================

    let DEBUG = false;

    // フィルタ状態
    let filterEnabled = false;
    let filterMode = 'whitelist'; // 'whitelist' | 'blacklist'
    let selfChannelId = null;
    let ownerChannelId = null;
    let allowedUsers = []; // { channelId, displayName, avatarUrl }
    let blockedUsers = []; // { channelId, displayName, avatarUrl }
    let treatModeratorAsStreamer = false;
    let startupBehavior = 'alwaysOff';

    // ページ情報
    let currentVideoId = null;
    let isReplayPage = false;
    let isValidPage = false;

    // 直近の発言者
    const recentSpeakers = []; // { channelId, displayName, avatarUrl }

    // MutationObserver
    let chatObserver = null;
    let chatContainer = null;
    let scrollerElement = null;

    // 要素IDとチャンネルIDのマッピング（injectedスクリプトから受信）
    const elementChannelIdMap = new Map();

    // 非表示にしたコメントを追跡
    const hiddenElements = new Set();

    // ========================================
    // ユーティリティ
    // ========================================

    function log(...args) {
        if (DEBUG) {
            console.log('[YT-Chat-Filter CS]', ...args);
        }
    }

    function error(...args) {
        console.error('[YT-Chat-Filter CS]', ...args);
    }

    /**
     * URLからvideoIdを取得
     */
    function getVideoIdFromUrl() {
        const url = new URL(window.location.href);

        const vParam = url.searchParams.get('v');
        if (vParam) return vParam;

        const continuation = url.searchParams.get('continuation');
        if (continuation) {
            try {
                const decoded = atob(continuation);
                const match = decoded.match(/([a-zA-Z0-9_-]{11})/);
                if (match) return match[1];
            } catch (e) {
                // 無視
            }
        }

        if (document.referrer) {
            try {
                const refUrl = new URL(document.referrer);
                const refV = refUrl.searchParams.get('v');
                if (refV) return refV;
            } catch (e) {
                // 無視
            }
        }

        const watchLink = document.querySelector('a[href*="/watch?v="]');
        if (watchLink) {
            const match = watchLink.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
            if (match) return match[1];
        }

        return null;
    }

    function checkIsReplayPage() {
        return window.location.pathname.includes('live_chat_replay');
    }

    function checkIsValidPage() {
        return window.location.pathname.includes('live_chat');
    }

    // ========================================
    // スクリプト注入（フォールバック用）
    // ========================================

    function ensureInjectScript() {
        try {
            // manifest.json で world: MAIN 指定されているが、フォールバックとして挿入
            const script = document.createElement('script');
            script.src = chrome.runtime.getURL('injectScript.js');
            script.onload = function () {
                this.remove();
            };
            (document.head || document.documentElement).appendChild(script);
        } catch (e) {
            // Manifest V3 の world: MAIN で既に動いている場合は無視
        }
    }

    // 注入スクリプトからのメッセージを受信
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;

        if (event.data?.type === 'YT_CHAT_FILTER_CHANNEL_DATA') {
            if (event.data.detectedOwnerId && !ownerChannelId) {
                ownerChannelId = event.data.detectedOwnerId;
                log('オーナーチャンネルIDを自動補完 (初回収集):', ownerChannelId);
            }

            event.data.data.forEach(item => {
                if (item.elementId) {
                    elementChannelIdMap.set(item.elementId, item.channelId);
                }
                addToRecentSpeakersFromData(item);
            });

            if (filterEnabled) {
                filterExistingComments();
            }
        }

        if (event.data?.type === 'YT_CHAT_FILTER_NEW_MESSAGES') {
            if (event.data.detectedOwnerId && !ownerChannelId) {
                ownerChannelId = event.data.detectedOwnerId;
                log('オーナーチャンネルIDを自動補完 (新規メッセージ):', ownerChannelId);
            }

            event.data.data.forEach(item => {
                if (item.elementId) {
                    elementChannelIdMap.set(item.elementId, item.channelId);
                }
                addToRecentSpeakersFromData(item);

                if (filterEnabled && item.elementId) {
                    const element = document.getElementById(item.elementId);
                    if (element && !shouldShowByChannelId(item.channelId, element)) {
                        hideComment(element);
                    }
                }
            });
        }
    });

    function addToRecentSpeakersFromData(item) {
        if (!item.channelId) return;

        const existingIndex = recentSpeakers.findIndex(s => s.channelId === item.channelId);
        if (existingIndex !== -1) {
            const existing = recentSpeakers.splice(existingIndex, 1)[0];
            recentSpeakers.unshift(existing);
            return;
        }

        recentSpeakers.unshift({
            channelId: item.channelId,
            displayName: item.displayName || 'Unknown',
            avatarUrl: item.avatarUrl || ''
        });

        while (recentSpeakers.length > MAX_RECENT_SPEAKERS) {
            recentSpeakers.pop();
        }
    }

    // ========================================
    // チャンネルID取得
    // ========================================

    function getAuthorChannelId(element) {
        const elemId = element.getAttribute('id');
        if (elemId && elementChannelIdMap.has(elemId)) {
            return elementChannelIdMap.get(elemId);
        }

        let authorId = element.getAttribute('author-external-channel-id');
        if (authorId && authorId.startsWith('UC')) return authorId;

        authorId = element.getAttribute('author-id');
        if (authorId && authorId.startsWith('UC')) return authorId;

        const dataAttrs = ['data-author-id', 'data-channel-external-id', 'data-author-external-channel-id'];
        for (const attr of dataAttrs) {
            authorId = element.getAttribute(attr);
            if (authorId && authorId.startsWith('UC')) return authorId;
        }

        const photoLink = element.querySelector('#author-photo a');
        if (photoLink) {
            const href = photoLink.getAttribute('href');
            if (href) {
                const match = href.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
                if (match) return match[1];
            }
        }

        const authorNameLink = element.querySelector('#author-name a, a#author-name, #author-name yt-formatted-string');
        if (authorNameLink) {
            const href = authorNameLink.getAttribute('href') || authorNameLink.closest('a')?.getAttribute('href');
            if (href) {
                const match = href.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
                if (match) return match[1];
            }
        }

        const elemWithData = element.querySelector('[data-channel-external-id], [author-external-channel-id]');
        if (elemWithData) {
            authorId = elemWithData.getAttribute('data-channel-external-id') ||
                elemWithData.getAttribute('author-external-channel-id');
            if (authorId && authorId.startsWith('UC')) return authorId;
        }

        const authorChip = element.querySelector('yt-live-chat-author-chip');
        if (authorChip) {
            authorId = authorChip.getAttribute('author-external-channel-id');
            if (authorId && authorId.startsWith('UC')) return authorId;
        }

        return null;
    }

    function getAuthorDisplayName(element) {
        const authorName = element.querySelector('#author-name');
        return authorName ? authorName.textContent?.trim() || null : null;
    }

    function getAuthorAvatarUrl(element) {
        const img = element.querySelector('#author-photo img, #author-photo yt-img-shadow img');
        return img ? img.src || null : null;
    }

    function isModerator(element) {
        return element.querySelector(MODERATOR_BADGE_SELECTOR) !== null;
    }

    function isOwner(element) {
        return element.querySelector(OWNER_BADGE_SELECTOR) !== null;
    }

    function isAlwaysVisible(element) {
        const tagName = element.tagName.toLowerCase();
        if (ALWAYS_VISIBLE_TAGS.includes(tagName)) return true;
        if (element.closest('yt-live-chat-banner-manager')) return true;
        return false;
    }

    function isChatMessage(element) {
        const tagName = element.tagName.toLowerCase();
        return CHAT_MESSAGE_TAGS.includes(tagName);
    }

    // ========================================
    // フィルタ判定ロジック
    // ========================================

    function shouldShow(element) {
        if (isAlwaysVisible(element)) return true;
        if (!isChatMessage(element)) return true;

        const authorId = getAuthorChannelId(element);

        // オーナー判定＆自動学習
        if (isOwner(element)) {
            if (authorId) {
                if (!ownerChannelId) {
                    ownerChannelId = authorId;
                    log('オーナーIDをメッセージから自動認識:', ownerChannelId);
                }
                addToRecentSpeakers(element, authorId);
            }
            return true;
        }

        // モデレーター設定
        if (treatModeratorAsStreamer && isModerator(element)) {
            if (authorId) addToRecentSpeakers(element, authorId);
            return true;
        }

        if (!authorId) {
            return true; // 安全側: ID不明時は表示
        }

        addToRecentSpeakers(element, authorId);

        return shouldShowByChannelId(authorId, element);
    }

    function shouldShowByChannelId(channelId, element) {
        if (!channelId) return true;

        if (element && isOwner(element)) return true;
        if (treatModeratorAsStreamer && element && isModerator(element)) return true;

        // --- ブラックリストモード ---
        if (filterMode === 'blacklist') {
            if (blockedUsers.some(u => u.channelId === channelId)) {
                return false; // ブロック対象なら非表示
            }
            return true; // それ以外は表示
        }

        // --- ホワイトリストモード ---
        if (channelId === selfChannelId) return true;
        if (ownerChannelId && channelId === ownerChannelId) return true;
        if (allowedUsers.some(u => u.channelId === channelId)) return true;

        return false; // それ以外は非表示
    }

    function addToRecentSpeakers(element, channelId) {
        const existingIndex = recentSpeakers.findIndex(s => s.channelId === channelId);
        if (existingIndex !== -1) {
            const existing = recentSpeakers.splice(existingIndex, 1)[0];
            recentSpeakers.unshift(existing);
            return;
        }

        const displayName = getAuthorDisplayName(element);
        const avatarUrl = getAuthorAvatarUrl(element);

        recentSpeakers.unshift({
            channelId,
            displayName: displayName || 'Unknown',
            avatarUrl: avatarUrl || ''
        });

        while (recentSpeakers.length > MAX_RECENT_SPEAKERS) {
            recentSpeakers.pop();
        }
    }

    // ========================================
    // コメントの非表示・復元・スクロール追従
    // ========================================

    function hideComment(element) {
        if (hiddenElements.has(element)) return;

        element.style.display = 'none';
        element.setAttribute('data-yt-chat-filter-hidden', 'true');
        hiddenElements.add(element);

        ensureScrollAtBottom();
    }

    function restoreAllComments() {
        if (hiddenElements.size === 0) return;

        for (const element of hiddenElements) {
            try {
                element.style.display = '';
                element.removeAttribute('data-yt-chat-filter-hidden');
            } catch (e) {
                // 無視
            }
        }
        hiddenElements.clear();

        const stillHidden = document.querySelectorAll('[data-yt-chat-filter-hidden]');
        stillHidden.forEach(el => {
            el.style.display = '';
            el.removeAttribute('data-yt-chat-filter-hidden');
        });
    }

    function ensureScrollAtBottom() {
        if (!scrollerElement) {
            scrollerElement = document.querySelector('yt-live-chat-item-list-renderer #item-scroller, #chat-messages #item-scroller');
        }

        if (scrollerElement) {
            // スクロール位置が最下部付近にある場合、自動追従を補助
            const distanceToBottom = scrollerElement.scrollHeight - scrollerElement.scrollTop - scrollerElement.clientHeight;
            if (distanceToBottom < 100) {
                scrollerElement.scrollTop = scrollerElement.scrollHeight;
            }
        }
    }

    function filterExistingComments() {
        if (!chatContainer) return;

        const items = chatContainer.querySelectorAll(CHAT_MESSAGE_TAGS.join(','));
        for (const item of items) {
            if (!shouldShow(item)) {
                hideComment(item);
            }
        }
    }

    function processNewComment(element) {
        if (!filterEnabled) return;

        if (!shouldShow(element)) {
            hideComment(element);
        }
    }

    function handleMutations(mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (isChatMessage(node)) {
                        const authorId = getAuthorChannelId(node);
                        if (authorId) addToRecentSpeakers(node, authorId);
                        if (filterEnabled) processNewComment(node);
                    }

                    const childMessages = node.querySelectorAll?.(CHAT_MESSAGE_TAGS.join(','));
                    if (childMessages) {
                        for (const child of childMessages) {
                            const childAuthorId = getAuthorChannelId(child);
                            if (childAuthorId) addToRecentSpeakers(child, childAuthorId);
                            if (filterEnabled) processNewComment(child);
                        }
                    }
                }
            }
        }
    }

    // ========================================
    // 監視の制御
    // ========================================

    function findChatContainer() {
        return document.querySelector('yt-live-chat-item-list-renderer #items, #chat-messages #items, #item-list #items');
    }

    function startObserver() {
        if (chatObserver) return;

        chatContainer = findChatContainer();
        if (!chatContainer) {
            setTimeout(startObserver, 1000);
            return;
        }

        scrollerElement = document.querySelector('yt-live-chat-item-list-renderer #item-scroller, #chat-messages #item-scroller');

        const existingMessages = chatContainer.querySelectorAll(CHAT_MESSAGE_TAGS.join(','));
        existingMessages.forEach(msg => {
            const authorId = getAuthorChannelId(msg);
            if (authorId) addToRecentSpeakers(msg, authorId);
            if (isOwner(msg) && authorId && !ownerChannelId) {
                ownerChannelId = authorId;
            }
        });

        chatObserver = new MutationObserver(handleMutations);
        chatObserver.observe(chatContainer, { childList: true, subtree: true });

        log('チャット監視開始成功');
    }

    function enableFilter() {
        if (filterEnabled) return;
        filterEnabled = true;
        saveLastEnabledState(true);
        filterExistingComments();
        log('フィルタ有効化');
    }

    function disableFilter() {
        if (!filterEnabled) return;
        filterEnabled = false;
        saveLastEnabledState(false);
        restoreAllComments();
        log('フィルタ無効化');
    }

    // ========================================
    // 設定管理
    // ========================================

    async function loadSettings() {
        try {
            const storageKey = ownerChannelId ? `streamer:${ownerChannelId}` : 'streamer:unknown';
            const result = await chrome.storage.local.get(['self', 'settings', storageKey]);

            selfChannelId = result.self?.channelId || null;

            const settings = result.settings || {};
            filterMode = settings.filterMode || 'whitelist';
            treatModeratorAsStreamer = settings.treatModeratorAsStreamer || false;
            startupBehavior = settings.startupBehavior || 'alwaysOff';
            DEBUG = settings.debug || false;

            const streamerData = result[storageKey] || {};
            allowedUsers = streamerData.allowed || [];
            blockedUsers = streamerData.blocked || [];

            if (startupBehavior === 'restoreLast' && streamerData.lastEnabled) {
                if (filterMode === 'blacklist' || selfChannelId) {
                    setTimeout(() => enableFilter(), 1000);
                }
            }
        } catch (e) {
            error('設定読み込みエラー:', e);
        }
    }

    async function saveLastEnabledState(enabled) {
        try {
            const key = ownerChannelId ? `streamer:${ownerChannelId}` : 'streamer:unknown';
            const result = await chrome.storage.local.get(key);
            const data = result[key] || { allowed: [], blocked: [] };
            data.lastEnabled = enabled;
            await chrome.storage.local.set({ [key]: data });
        } catch (e) {
            error('状態保存エラー:', e);
        }
    }

    async function addAllowedUser(user) {
        if (!user.channelId || allowedUsers.some(u => u.channelId === user.channelId)) return false;

        allowedUsers.push(user);
        try {
            const key = ownerChannelId ? `streamer:${ownerChannelId}` : 'streamer:unknown';
            const result = await chrome.storage.local.get(key);
            const data = result[key] || { allowed: [], blocked: [], lastEnabled: filterEnabled };
            data.allowed = allowedUsers;
            await chrome.storage.local.set({ [key]: data });

            if (filterEnabled && filterMode === 'whitelist') {
                restoreAllComments();
                filterExistingComments();
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    async function removeAllowedUser(channelId) {
        const index = allowedUsers.findIndex(u => u.channelId === channelId);
        if (index === -1) return false;

        allowedUsers.splice(index, 1);
        try {
            const key = ownerChannelId ? `streamer:${ownerChannelId}` : 'streamer:unknown';
            const result = await chrome.storage.local.get(key);
            const data = result[key] || { allowed: [], blocked: [], lastEnabled: filterEnabled };
            data.allowed = allowedUsers;
            await chrome.storage.local.set({ [key]: data });

            if (filterEnabled && filterMode === 'whitelist') {
                restoreAllComments();
                filterExistingComments();
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    async function addBlockedUser(user) {
        if (!user.channelId || blockedUsers.some(u => u.channelId === user.channelId)) return false;

        blockedUsers.push(user);
        try {
            const key = ownerChannelId ? `streamer:${ownerChannelId}` : 'streamer:unknown';
            const result = await chrome.storage.local.get(key);
            const data = result[key] || { allowed: [], blocked: [], lastEnabled: filterEnabled };
            data.blocked = blockedUsers;
            await chrome.storage.local.set({ [key]: data });

            if (filterEnabled && filterMode === 'blacklist') {
                filterExistingComments();
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    async function removeBlockedUser(channelId) {
        const index = blockedUsers.findIndex(u => u.channelId === channelId);
        if (index === -1) return false;

        blockedUsers.splice(index, 1);
        try {
            const key = ownerChannelId ? `streamer:${ownerChannelId}` : 'streamer:unknown';
            const result = await chrome.storage.local.get(key);
            const data = result[key] || { allowed: [], blocked: [], lastEnabled: filterEnabled };
            data.blocked = blockedUsers;
            await chrome.storage.local.set({ [key]: data });

            if (filterEnabled && filterMode === 'blacklist') {
                restoreAllComments();
                filterExistingComments();
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    // ========================================
    // メッセージハンドラ
    // ========================================

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
            case 'GET_STATUS':
                sendResponse({
                    filterEnabled,
                    filterMode,
                    selfChannelId,
                    ownerChannelId,
                    allowedUsers,
                    blockedUsers,
                    isReplayPage,
                    isValidPage
                });
                break;

            case 'ENABLE_FILTER':
                if (filterMode === 'whitelist' && !selfChannelId) {
                    sendResponse({ success: false, error: 'SELF_NOT_SET' });
                    return false;
                }
                enableFilter();
                sendResponse({ success: true });
                break;

            case 'DISABLE_FILTER':
                disableFilter();
                sendResponse({ success: true });
                break;

            case 'GET_RECENT_SPEAKERS':
                sendResponse({
                    success: true,
                    speakers: recentSpeakers
                });
                break;

            case 'ADD_ALLOWED_USER':
                addAllowedUser(message.user).then(success => sendResponse({ success }));
                return true;

            case 'REMOVE_ALLOWED_USER':
                removeAllowedUser(message.channelId).then(success => sendResponse({ success }));
                return true;

            case 'ADD_BLOCKED_USER':
                addBlockedUser(message.user).then(success => sendResponse({ success }));
                return true;

            case 'REMOVE_BLOCKED_USER':
                removeBlockedUser(message.channelId).then(success => sendResponse({ success }));
                return true;

            case 'UPDATE_SETTINGS':
                if (message.filterMode !== undefined) filterMode = message.filterMode;
                if (message.treatModeratorAsStreamer !== undefined) treatModeratorAsStreamer = message.treatModeratorAsStreamer;
                if (message.startupBehavior !== undefined) startupBehavior = message.startupBehavior;
                if (message.debug !== undefined) DEBUG = message.debug;

                if (filterEnabled) {
                    restoreAllComments();
                    filterExistingComments();
                }
                sendResponse({ success: true });
                break;

            default:
                sendResponse({ error: 'Unknown message type' });
        }
        return false;
    });

    // ========================================
    // 初期化
    // ========================================

    async function initialize() {
        isReplayPage = checkIsReplayPage();
        isValidPage = checkIsValidPage();
        currentVideoId = getVideoIdFromUrl();

        if (!isValidPage) return;

        if (currentVideoId) {
            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'GET_OWNER_CHANNEL_ID',
                    videoId: currentVideoId
                });

                if (response?.success && response.channelId) {
                    ownerChannelId = response.channelId;
                }
            } catch (e) {
                // オーナーバッジによる自動判定へフォールバック
            }
        }

        await loadSettings();
        ensureInjectScript();
        startObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

    // ストレージ変更監視
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;

        if (changes.settings) {
            const newSettings = changes.settings.newValue || {};
            filterMode = newSettings.filterMode || 'whitelist';
            treatModeratorAsStreamer = newSettings.treatModeratorAsStreamer || false;
            startupBehavior = newSettings.startupBehavior || 'alwaysOff';
            DEBUG = newSettings.debug || false;

            if (filterEnabled) {
                restoreAllComments();
                filterExistingComments();
            }
        }

        if (changes.self) {
            selfChannelId = changes.self.newValue?.channelId || null;
        }

        if (ownerChannelId && changes[`streamer:${ownerChannelId}`]) {
            const newData = changes[`streamer:${ownerChannelId}`].newValue || {};
            allowedUsers = newData.allowed || [];
            blockedUsers = newData.blocked || [];

            if (filterEnabled) {
                restoreAllComments();
                filterExistingComments();
            }
        }
    });

})();
