/**
 * YouTube Live Chat Filter - Background Service Worker
 * 
 * 役割:
 * - 配信者チャンネルIDの取得（watchページからfetch）
 * - メッセージハンドリング（content script / popup との通信）
 */

// デバッグログ制御
let DEBUG = false;

function log(...args) {
  if (DEBUG) {
    console.log('[YT-Chat-Filter BG]', ...args);
  }
}

/**
 * ytInitialPlayerResponse から JSON を抽出する
 * 括弧の深さを追跡して正しくJSONブロックを切り出す
 */
function extractJsonFromScript(html, variableName) {
  const searchStr = `var ${variableName} = `;
  const startIndex = html.indexOf(searchStr);
  if (startIndex === -1) {
    // 別のパターンも試す
    const altSearchStr = `${variableName} = `;
    const altStartIndex = html.indexOf(altSearchStr);
    if (altStartIndex === -1) {
      return null;
    }
    return extractJsonBlock(html, altStartIndex + altSearchStr.length);
  }
  return extractJsonBlock(html, startIndex + searchStr.length);
}

/**
 * 指定位置から始まるJSONオブジェクトを括弧の深さで切り出す
 */
function extractJsonBlock(str, startIndex) {
  if (str[startIndex] !== '{') {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < str.length; i++) {
    const char = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return str.substring(startIndex, i + 1);
      }
    }
  }

  return null;
}

/**
 * videoId から配信者（オーナー）のチャンネルIDを取得
 * 複数の方法を試みて堅牢性を向上
 */
async function getOwnerChannelId(videoId) {
  if (!videoId) {
    console.warn('[YT-Chat-Filter BG] videoId が空です');
    return null;
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    console.log('[YT-Chat-Filter BG] Fetching:', url);

    const response = await fetch(url, {
      credentials: 'omit',
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      console.warn('[YT-Chat-Filter BG] Fetch failed:', response.status, response.statusText);
      return null;
    }

    const html = await response.text();
    console.log('[YT-Chat-Filter BG] HTML取得成功, 長さ:', html.length);

    // 方法1: ytInitialPlayerResponse から取得
    const jsonStr = extractJsonFromScript(html, 'ytInitialPlayerResponse');
    if (jsonStr) {
      try {
        const data = JSON.parse(jsonStr);
        const channelId = data?.videoDetails?.channelId;
        if (channelId && channelId.startsWith('UC')) {
          console.log('[YT-Chat-Filter BG] 方法1成功 - Owner channelId:', channelId);
          return channelId;
        }
      } catch (parseError) {
        console.warn('[YT-Chat-Filter BG] ytInitialPlayerResponse のパース失敗:', parseError.message);
      }
    } else {
      console.log('[YT-Chat-Filter BG] ytInitialPlayerResponse が見つかりません');
    }

    // 方法2: ytInitialData から取得
    const ytInitialDataStr = extractJsonFromScript(html, 'ytInitialData');
    if (ytInitialDataStr) {
      try {
        const data = JSON.parse(ytInitialDataStr);
        // videoOwnerRenderer からチャンネルIDを取得
        const ownerMatch = JSON.stringify(data).match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);
        if (ownerMatch) {
          console.log('[YT-Chat-Filter BG] 方法2成功 - Owner channelId:', ownerMatch[1]);
          return ownerMatch[1];
        }
      } catch (parseError) {
        console.warn('[YT-Chat-Filter BG] ytInitialData のパース失敗:', parseError.message);
      }
    }

    // 方法3: メタタグから取得
    const channelUrlMatch = html.match(/<link itemprop="url" href="https?:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})">/);
    if (channelUrlMatch) {
      console.log('[YT-Chat-Filter BG] 方法3成功 - Owner channelId:', channelUrlMatch[1]);
      return channelUrlMatch[1];
    }

    // 方法4: browseId パターン
    const browseIdMatch = html.match(/"browseId":"(UC[a-zA-Z0-9_-]{22})"/);
    if (browseIdMatch) {
      console.log('[YT-Chat-Filter BG] 方法4成功 - Owner channelId:', browseIdMatch[1]);
      return browseIdMatch[1];
    }

    // 方法5: externalChannelId パターン
    const externalIdMatch = html.match(/"externalChannelId":"(UC[a-zA-Z0-9_-]{22})"/);
    if (externalIdMatch) {
      console.log('[YT-Chat-Filter BG] 方法5成功 - Owner channelId:', externalIdMatch[1]);
      return externalIdMatch[1];
    }

    console.warn('[YT-Chat-Filter BG] すべての方法でチャンネルID取得に失敗');
    // デバッグ用: HTMLの一部を出力
    console.log('[YT-Chat-Filter BG] HTML先頭500文字:', html.substring(0, 500));
    return null;

  } catch (error) {
    console.error('[YT-Chat-Filter BG] getOwnerChannelId エラー:', error.message, error.stack);
    return null;
  }
}

/**
 * @handle や URL からチャンネルIDを解決する
 */
async function resolveChannelId(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();

  // すでに UC... 形式の場合はそのまま返す
  if (trimmed.startsWith('UC') && trimmed.length === 24) {
    return trimmed;
  }

  // URL から抽出を試みる
  let identifier = trimmed;

  // https://www.youtube.com/channel/UC... 形式
  const channelMatch = trimmed.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/);
  if (channelMatch) {
    return channelMatch[1];
  }

  // https://www.youtube.com/@handle 形式
  const handleMatch = trimmed.match(/youtube\.com\/@([a-zA-Z0-9_.-]+)/);
  if (handleMatch) {
    identifier = '@' + handleMatch[1];
  }

  // @ で始まる場合はハンドルとして解決
  if (identifier.startsWith('@')) {
    try {
      const url = `https://www.youtube.com/${identifier}`;
      log('Resolving handle:', url);

      const response = await fetch(url, {
        credentials: 'omit',
        headers: {
          'Accept': 'text/html',
          'Accept-Language': 'ja,en;q=0.9'
        }
      });

      if (!response.ok) {
        log('Handle resolution failed:', response.status);
        return null;
      }

      const html = await response.text();

      // canonical URL からチャンネルIDを抽出
      const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})"/);
      if (canonicalMatch) {
        log('Resolved channelId:', canonicalMatch[1]);
        return canonicalMatch[1];
      }

      // 別のパターン: browse_id
      const browseIdMatch = html.match(/"browseId":"(UC[a-zA-Z0-9_-]{22})"/);
      if (browseIdMatch) {
        log('Resolved channelId (browseId):', browseIdMatch[1]);
        return browseIdMatch[1];
      }

      log('ハンドルからチャンネルIDを解決できませんでした');
      return null;

    } catch (error) {
      log('resolveChannelId エラー:', error);
      return null;
    }
  }

  // UC... 形式が完全でない場合
  if (trimmed.startsWith('UC')) {
    // 長さが足りない場合はnull
    return null;
  }

  return null;
}

/**
 * デバッグモードを設定から読み込む
 */
async function loadDebugSetting() {
  try {
    const result = await chrome.storage.local.get('settings');
    DEBUG = result.settings?.debug || false;
  } catch (e) {
    // 無視
  }
}

// 起動時にデバッグ設定を読み込む
loadDebugSetting();

/**
 * メッセージハンドラ
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log('Message received:', message);

  if (message.type === 'GET_OWNER_CHANNEL_ID') {
    getOwnerChannelId(message.videoId)
      .then(channelId => {
        sendResponse({ success: true, channelId });
      })
      .catch(error => {
        log('Error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // 非同期レスポンスを示す
  }

  if (message.type === 'RESOLVE_CHANNEL_ID') {
    resolveChannelId(message.input)
      .then(channelId => {
        sendResponse({ success: true, channelId });
      })
      .catch(error => {
        log('Error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.type === 'UPDATE_DEBUG') {
    DEBUG = message.debug;
    sendResponse({ success: true });
    return false;
  }

  return false;
});

log('Background service worker started');
