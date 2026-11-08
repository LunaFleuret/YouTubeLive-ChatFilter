/**
 * YouTube Live Chat Filter - Inject Script
 * 
 * このスクリプトはメインワールド(ページのコンテキスト)で実行され、
 * YouTubeのPolymerデータに直接アクセスしてチャンネルIDを取得します。
 */

(function () {
    'use strict';

    if (window.__YT_CHAT_FILTER_INJECTED__) {
        return;
    }
    window.__YT_CHAT_FILTER_INJECTED__ = true;

    console.log('[YT-Chat-Filter Inject] スクリプト初期化');

    /**
     * チャットメッセージ要素からチャンネルIDを取得
     */
    function getChannelIdFromElement(element) {
        // 方法1: __data プロパティから取得 (Polymer)
        if (element.__data) {
            const authorId = element.__data.authorExternalChannelId ||
                element.__data.authorId;
            if (authorId && authorId.startsWith('UC')) {
                return authorId;
            }

            if (element.__data.data?.authorExternalChannelId) {
                return element.__data.data.authorExternalChannelId;
            }
        }

        // 方法2: data プロパティから取得
        if (element.data) {
            const authorId = element.data.authorExternalChannelId ||
                element.data.authorId;
            if (authorId && authorId.startsWith('UC')) {
                return authorId;
            }
        }

        // 方法3: polymerController から取得
        if (element.polymerController?.__data) {
            const authorId = element.polymerController.__data.authorExternalChannelId;
            if (authorId && authorId.startsWith('UC')) {
                return authorId;
            }
        }

        // 方法4: _instance から取得
        if (element._instance?.__data) {
            const authorId = element._instance.__data.authorExternalChannelId;
            if (authorId && authorId.startsWith('UC')) {
                return authorId;
            }
        }

        // 方法5: 属性から取得
        const attrId = element.getAttribute('author-external-channel-id');
        if (attrId && attrId.startsWith('UC')) {
            return attrId;
        }

        return null;
    }

    /**
     * 要素がオーナー（配信者）かどうか判定
     */
    function isOwnerElement(element) {
        return element.querySelector('yt-live-chat-author-badge-renderer[type="owner"]') !== null;
    }

    /**
     * 全メッセージのチャンネルIDを収集してContent Scriptに送信
     */
    function collectAndSendChannelIds() {
        const messages = document.querySelectorAll(
            'yt-live-chat-text-message-renderer, ' +
            'yt-live-chat-paid-message-renderer, ' +
            'yt-live-chat-paid-sticker-renderer, ' +
            'yt-live-chat-membership-item-renderer'
        );

        const channelData = [];
        let detectedOwnerId = null;

        messages.forEach((msg, index) => {
            const channelId = getChannelIdFromElement(msg);
            const displayName = msg.querySelector('#author-name')?.textContent?.trim() || '';
            const avatarUrl = msg.querySelector('#author-photo img')?.src || '';
            const isOwner = isOwnerElement(msg);

            if (isOwner && channelId) {
                detectedOwnerId = channelId;
            }

            if (channelId) {
                channelData.push({
                    channelId,
                    displayName,
                    avatarUrl,
                    isOwner,
                    elementId: msg.id || `msg-${index}`
                });
            }
        });

        // Content Script にデータを送信
        window.postMessage({
            type: 'YT_CHAT_FILTER_CHANNEL_DATA',
            data: channelData,
            detectedOwnerId
        }, '*');
    }

    /**
     * 新しいメッセージを監視
     */
    function observeNewMessages() {
        const container = document.querySelector('yt-live-chat-item-list-renderer #items, #chat-messages #items, #item-list #items');
        if (!container) {
            setTimeout(observeNewMessages, 1000);
            return;
        }

        console.log('[YT-Chat-Filter Inject] チャットコンテナ検出、監視開始');

        // 初回収集
        collectAndSendChannelIds();

        // 新規メッセージを監視
        const observer = new MutationObserver((mutations) => {
            const newMessages = [];
            let detectedOwnerId = null;

            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.tagName?.toLowerCase().includes('yt-live-chat-') &&
                            node.tagName?.toLowerCase().includes('-renderer')) {
                            const channelId = getChannelIdFromElement(node);
                            const isOwner = isOwnerElement(node);

                            if (isOwner && channelId) {
                                detectedOwnerId = channelId;
                            }

                            if (channelId) {
                                newMessages.push({
                                    channelId,
                                    displayName: node.querySelector('#author-name')?.textContent?.trim() || '',
                                    avatarUrl: node.querySelector('#author-photo img')?.src || '',
                                    isOwner,
                                    elementId: node.id || ''
                                });
                            }
                        }
                    }
                });
            });

            if (newMessages.length > 0) {
                window.postMessage({
                    type: 'YT_CHAT_FILTER_NEW_MESSAGES',
                    data: newMessages,
                    detectedOwnerId
                }, '*');
            }
        });

        observer.observe(container, { childList: true, subtree: true });
    }

    // Content Script からのリクエストを受信
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;

        if (event.data?.type === 'YT_CHAT_FILTER_REQUEST_DATA') {
            collectAndSendChannelIds();
        }
    });

    // 開始
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeNewMessages);
    } else {
        observeNewMessages();
    }

})();
