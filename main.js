/* -------------------------------------------------------------
   Music Runner v2.0 - Application Logic (Vanilla JS)
   ------------------------------------------------------------- */

// --- 旧 Eruda (デバッグツール) 残存要素の強制的クリア ---
(function cleanupEruda() {
    try {
        const removeTargets = ['eruda', 'eruda-container'];
        removeTargets.forEach(idOrClass => {
            document.querySelectorAll('#' + idOrClass + ', .' + idOrClass).forEach(el => el.remove());
        });
        localStorage.removeItem('eruda-dev-tools');
        localStorage.removeItem('eruda-entry-btn');
        localStorage.removeItem('eruda-active-tab');
    } catch (e) {}
})();

// --- IndexedDB ユーティリティ (前回のフォルダー保存用) ---
const DB_NAME = 'MusicRunnerDB';
const STORE_NAME = 'keyval';
const LAST_DIR_KEY = 'lastDirectoryHandle';
const LAST_FOLDER_META_KEY = 'musicrunner_last_folder_meta';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function getVal(key) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (err) {
        console.error('IndexedDB getVal Error:', err);
        return null;
    }
}

async function setVal(key, val) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(val, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.error('IndexedDB setVal Error:', err);
        throw err;
    }
}

function saveLastFolderMeta(folderName, source) {
    if (!folderName) return;
    activeFolderName = folderName;
    try {
        localStorage.setItem(LAST_FOLDER_META_KEY, JSON.stringify({
            folderName,
            source, // 'handle' | 'fallback'
            savedAt: Date.now()
        }));
    } catch (err) {
        console.warn('last folder meta save failed:', err);
    }
}

function getLastFolderMeta() {
    try {
        const raw = localStorage.getItem(LAST_FOLDER_META_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

async function updateLastFolderButton() {
    let canOpen = false;
    try {
        const lastHandle = await getVal(LAST_DIR_KEY);
        if (lastHandle) canOpen = true;
    } catch { /* ignore */ }
    if (!canOpen && getLastFolderMeta()) canOpen = true;
    if (!canOpen && cachedFolderFiles && cachedFolderFiles.length > 0) canOpen = true;

    if (canOpen) {
        btnOpenLastFolder.classList.remove('disabled');
        btnOpenLastFolder.removeAttribute('disabled');
    } else {
        btnOpenLastFolder.classList.add('disabled');
        btnOpenLastFolder.setAttribute('disabled', '');
    }
}

// --- アプリケーション状態 ---
let directoryHandle = null;
let rootItems = [];           // ツリー構造データ
let flatFiles = [];           // 再生可能なファイルのフラット配列
let playlistQueue = [];       // チェックが入っているファイルの配列
let currentPlayingFile = null;// 現在再生中のファイル情報 (node)
let loopMode = 'playlist';    // 'playlist' (チェック順次リピート) or 'single' (単一曲ループ)
let isFolderLoaded = false;
let activeFolderName = null;  // 現在のフォルダ名（FSA / フォールバック共通）
let currentTreeItems = [];    // ファイルツリー（ルート一括チェック用）
let fileByPath = new Map();   // path → file node（クリック応答を高速化）
let folderByPath = new Map(); // path → folder node
let saveStateRaf = 0;
let stateSavePromise = Promise.resolve();
let bulkRefreshRaf = 0;
let pendingBulkRefreshFolders = null;
let cachedFolderFiles = null; // fallback入力からキャッシュしたファイル群（同一セッションのみ）
const MUSIC_ORDER_FILE = 'musics.json';
let draggedTreePath = null;
let dragOverRow = null;
let treeDragJustEnded = false;
let touchDragState = null;

// 状態記憶用 (LocalStorage)
let currentState = {
    openFolders: {},          // { [folderPath]: boolean }
    checkedFiles: {}          // { [filePath]: boolean }
};

// --- UI要素の取得 ---
const homeScreen = document.getElementById('home-screen');
const playScreen = document.getElementById('play-screen');

const btnOpenFile = document.getElementById('btn-open-file');
const btnOpenFolder = document.getElementById('btn-open-folder');
const btnOpenLastFolder = document.getElementById('btn-open-last-folder');

const inputFile = document.getElementById('input-file');
const inputFolder = document.getElementById('input-folder');

const mainVideo = document.getElementById('main-video');
const musicPlaceholder = document.getElementById('music-placeholder');
const currentTitle = document.getElementById('current-title');
const currentArtist = document.getElementById('current-artist');

const progressSlider = document.getElementById('progress-slider');
const volumeSlider = document.getElementById('volume-slider');
const volumeValue = document.getElementById('volume-value');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');

const btnLoop = document.getElementById('btn-loop');
const btnPlayPause = document.getElementById('btn-play-pause');
const btnBackHome = document.getElementById('btn-back-home');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');

const fileTreePanel = document.getElementById('file-tree-panel');
const fileTreeContainer = document.getElementById('file-tree-container');

// 読み込みオーバーレイ要素
const loadingOverlay = document.getElementById('loading-overlay');
const loadingTitle = document.getElementById('loading-title');
const loadingStatus = document.getElementById('loading-status');

// アイコン表示切り替え用
const iconLoop = btnLoop.querySelector('.icon-loop');
const iconPlay = btnPlayPause.querySelector('.icon-play');
const iconPause = btnPlayPause.querySelector('.icon-pause');

// --- 読み込みオーバーレイ制御 ---
let loadingScanCount = 0;
let loadingScanRaf = 0;
let loadingActive = false;

function showLoading(title = 'フォルダーを読み込んでいます') {
    if (!loadingOverlay) return;
    loadingTitle.textContent = title;
    loadingStatus.textContent = 'ファイルをスキャン中...';
    loadingOverlay.classList.remove('error');
    loadingOverlay.classList.add('active');
    loadingScanCount = 0;
    loadingActive = true;
}

function hideLoading() {
    if (!loadingOverlay) return;
    loadingOverlay.classList.remove('active', 'error');
    loadingActive = false;
    if (loadingScanRaf) {
        cancelAnimationFrame(loadingScanRaf);
        loadingScanRaf = 0;
    }
}

function showLoadingError(message) {
    if (!loadingOverlay) return;
    loadingTitle.textContent = '読み込みに失敗しました';
    loadingStatus.textContent = message;
    loadingOverlay.classList.add('error');
    // 一定時間後に自動的に閉じる
    setTimeout(() => {
        hideLoading();
    }, 2500);
}

function updateLoadingCount(count) {
    if (!loadingActive) return;
    loadingScanCount = count;
    // requestAnimationFrame で描画をスロットリング（毎フレーム1回だけ更新）
    if (!loadingScanRaf) {
        loadingScanRaf = requestAnimationFrame(() => {
            loadingScanRaf = 0;
            if (loadingActive) {
                loadingStatus.textContent = `${loadingScanCount} 個のエントリをスキャン中...`;
            }
        });
    }
}

function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

// --- 初期化処理 ---
window.addEventListener('DOMContentLoaded', async () => {
    // 保存された loopMode を復元
    const savedLoopMode = localStorage.getItem('musicrunner_loop_mode');
    if (savedLoopMode) {
        loopMode = savedLoopMode;
        updateLoopButtonUI();
    }

    // 前回のフォルダー（IndexedDB ハンドル or localStorage メタ）を確認
    try {
        await updateLastFolderButton();
    } catch (e) {
        console.warn('前回フォルダー情報の復元に失敗:', e);
    }

    // 保存された音量を復元
    const savedVolume = localStorage.getItem('musicrunner_volume');
    if (savedVolume !== null) {
        const vol = parseFloat(savedVolume);
        volumeSlider.value = vol;
        mainVideo.volume = vol;
        if (volumeValue) {
            volumeValue.textContent = `${Math.round(vol * 100)}%`;
        }
    }

    initEventListeners();
    initFileTreeInteraction();
    initSwipeGestures();
    initEffectsUI();
    initVisualizerSettingsUI();
// Register Service Worker for PWA
if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js')
        .catch(err => console.error('SW registration failed:', err));
}
});

// --- イベントリスナー登録 ---
function initEventListeners() {
    // 1. HOME画面のボタン
    btnOpenFile.addEventListener('click', () => {
        // File System Access API があれば使う、なければ従来の input file
        if (window.showOpenFilePicker) {
            handleOpenFilePicker();
        } else {
            inputFile.click();
        }
    });

    // フォルダーを開くボタン（FSA が使えればハンドルを IndexedDB に保存して次回も開ける）
    btnOpenFolder.addEventListener('click', () => openFolderPicker());

    btnOpenLastFolder.addEventListener('click', handleOpenLastDirectory);

    // 従来の input 要素の変更検知
    inputFile.addEventListener('change', handleFallbackFiles);
    inputFolder.addEventListener('change', handleFallbackFolder);

    // 2. コントローラー系
    btnPlayPause.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        togglePlayPause();
    });
    btnBackHome.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        goBackToHome();
    });
    btnLoop.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        toggleLoopMode();
    });
    btnPrev.addEventListener('click', () => playPreviousFile());
    btnNext.addEventListener('click', () => playNextFile());

    // ビデオ再生イベント
    mainVideo.addEventListener('timeupdate', updateProgressBar);
    mainVideo.addEventListener('loadedmetadata', () => {
        progressSlider.max = Math.floor(mainVideo.duration);
        timeTotal.textContent = formatTime(mainVideo.duration);
    });
    mainVideo.addEventListener('ended', handlePlaybackEnded);

    // スライダー操作
    progressSlider.addEventListener('input', () => {
        mainVideo.currentTime = progressSlider.value;
    });
    volumeSlider.addEventListener('input', () => {
        mainVideo.volume = volumeSlider.value;
        if (volumeValue) {
            volumeValue.textContent = `${Math.round(volumeSlider.value * 100)}%`;
        }
        localStorage.setItem('musicrunner_volume', volumeSlider.value);
    });

    setupMediaSession();
}

// --- メディアファイル判定ヘルパー ---
function isMediaFile(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const mediaExtensions = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'mp4', 'webm', 'mkv', 'mov'];
    return mediaExtensions.includes(ext);
}

function isVideoFile(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const videoExtensions = ['mp4', 'webm', 'mkv', 'mov'];
    return videoExtensions.includes(ext);
}

function formatTime(seconds) {
    if (isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

// --- 画面遷移 ---
function showScreen(screenId) {
    if (screenId === 'play') {
        homeScreen.classList.remove('active');
        playScreen.classList.add('active');
    } else {
        playScreen.classList.remove('active');
        homeScreen.classList.add('active');
        // ホームに戻る際に再生を一時停止する
        pauseMedia();
    }
}

function goBackToHome() {
    showScreen('home');
}

// --- 再生・一時停止の制御 ---
function togglePlayPause() {
    if (mainVideo.paused) {
        playMedia();
    } else {
        pauseMedia();
    }
}

function playMedia() {
    initAudioEffects();
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    
    mainVideo.play().then(() => {
        iconPlay.classList.add('hidden');
        iconPause.classList.remove('hidden');
        document.getElementById('music-placeholder').classList.add('playing');
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
        }
    }).catch(err => {
        if (err.name !== 'AbortError') {
            console.error('Play failed:', err);
        }
    });
}

function pauseMedia() {
    mainVideo.pause();
    iconPlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
    document.getElementById('music-placeholder').classList.remove('playing');
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
    }
}

function updateProgressBar() {
    if (!mainVideo.duration) return;
    progressSlider.value = Math.floor(mainVideo.currentTime);
    timeCurrent.textContent = formatTime(mainVideo.currentTime);
    // 再生位置を定期的に保存（復元用）
    scheduleSavePlaybackPosition();
}

// --- ループモードの切り替え ---
function toggleLoopMode() {
    if (loopMode === 'playlist') {
        loopMode = 'single';
    } else {
        loopMode = 'playlist';
    }
    localStorage.setItem('musicrunner_loop_mode', loopMode);
    updateLoopButtonUI();
}

function updateLoopButtonUI() {
    if (loopMode === 'single') {
        btnLoop.classList.add('active');
    } else {
        btnLoop.classList.remove('active');
    }
}

// --- ファイルを開く処理 (File System Access API) ---
async function handleOpenFilePicker() {
    try {
        const fileHandles = await window.showOpenFilePicker({
            multiple: true,
            types: [{
                description: 'Media Files',
                accept: {
                    'audio/*': ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'],
                    'video/*': ['.mp4', '.webm', '.mkv', '.mov']
                }
            }]
        });

        isFolderLoaded = false;

        flatFiles = [];
        for (const handle of fileHandles) {
            flatFiles.push({
                kind: 'file',
                name: handle.name,
                path: handle.name,
                handle: handle
            });
        }
        playlistQueue = [...flatFiles];

        if (playlistQueue.length > 0) {
            showScreen('play');
            playNode(playlistQueue[0]);
        }
    } catch (err) {
        console.log('User cancelled or error:', err);
    }
}

// --- フォルダーを開く（FSA 優先、失敗時は input） ---
async function openFolderPicker() {
    if (window.showDirectoryPicker) {
        try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            if (!(await verifyPermission(handle, true))) {
                alert('フォルダーの読み書き権限が必要です。');
                return;
            }
            await loadDirectory(handle);
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
            console.warn('showDirectoryPicker failed, falling back to input:', e);
        }
    }
    inputFolder.click();
}

// --- 前回のフォルダーを開く処理 ---
async function handleOpenLastDirectory() {
    // スマホ / フォールバック: キャッシュされたファイルがあれば再利用
    if (cachedFolderFiles && cachedFolderFiles.length > 0) {
        isFolderLoaded = true;

        let folderName = 'Local Folder';
        if (cachedFolderFiles[0].webkitRelativePath) {
            folderName = cachedFolderFiles[0].webkitRelativePath.split('/')[0];
        }
        activeFolderName = folderName;

        // 読み込みオーバーレイを表示（描画のためにイベントループに譲る）
        showLoading(`「${folderName}」を復元しています`);
        loadingStatus.textContent = `${cachedFolderFiles.length} 個のファイルを処理中...`;
        await yieldToUI();

        try {
            const stateKey = `musicrunner_state_${folderName}`;
            const savedState = localStorage.getItem(stateKey);
            currentState = savedState
                ? JSON.parse(savedState)
                : { openFolders: {}, checkedFiles: {} };

            flatFiles = [];
            const treeData = buildFallbackTree(cachedFolderFiles, folderName);
            flatFiles = flattenTreeFiles(treeData);
            updatePlaylistQueue();
            renderFileTree(treeData);
            showScreen('play');

            // 読み込み完了: オーバーレイを閉じる
            hideLoading();

            // 自動再生せず、チェック状態に応じて復元 or 「選択されていません」表示
            restorePlayback();
        } catch (err) {
            console.error('handleOpenLastDirectory cache restore error:', err);
            showLoadingError('フォルダーの復元中にエラーが発生しました');
        }
        return;
    }

    // IndexedDB に保存したディレクトリハンドルを使用（ページを閉じても復元可能）
    try {
        const lastHandle = await getVal(LAST_DIR_KEY);
        if (lastHandle) {
            const granted = await verifyPermission(lastHandle, true);
            if (granted) {
                await loadDirectory(lastHandle);
                return;
            }
            alert('フォルダーへのアクセス権限が拒否されました。再度選択してください。');
            return;
        }
    } catch (err) {
        console.error('Failed to open last directory:', err);
    }

    // フォールバックのみで開いていた場合: ファイル実体は保存できないため、同じフォルダーを再選択してもらう
    const meta = getLastFolderMeta();
    if (meta) {
        if (window.showDirectoryPicker) {
            try {
                const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
                if (!(await verifyPermission(handle, true))) {
                    alert('フォルダーの読み書き権限が必要です。');
                    return;
                }
                await loadDirectory(handle);
                return;
            } catch (e) {
                if (e.name === 'AbortError') return;
            }
        }
        inputFolder.click();
    }
}

async function verifyPermission(fileHandle, readWrite) {
    const options = {};
    if (readWrite) options.mode = 'readwrite';
    if ((await fileHandle.queryPermission(options)) === 'granted') return true;
    if ((await fileHandle.requestPermission(options)) === 'granted') return true;
    return false;
}

// --- ディレクトリの読み込みとツリー構築 ---
async function loadDirectory(dirHandle) {
    directoryHandle = dirHandle;
    isFolderLoaded = true;

    // 読み込みオーバーレイを表示
    showLoading(`「${dirHandle.name}」を読み込んでいます`);

    try {
        // IndexedDB に保存して次回起動時に備える
        await setVal(LAST_DIR_KEY, dirHandle);
        saveLastFolderMeta(dirHandle.name, 'handle');
        cachedFolderFiles = null;
        await updateLastFolderButton();

        // FSA で開いたフォルダーの状態は各階層の musics.json から復元する
        currentState = { openFolders: {}, checkedFiles: {} };

        // フォルダのトラバース
        rootItems = await traverseDirectory(dirHandle);
        flatFiles = flattenTreeFiles(rootItems);

        // プレイリストキューの作成 (チェックボックスの状態を考慮)
        updatePlaylistQueue();

        // UIレンダリング
        renderFileTree(rootItems);

        showScreen('play');

        // 読み込み完了: オーバーレイを閉じる
        hideLoading();

        // 自動再生せず、チェック状態に応じて復元 or 「選択されていません」表示
        restorePlayback();
    } catch (err) {
        console.error('loadDirectory error:', err);
        showLoadingError('フォルダーの読み込み中にエラーが発生しました');
    }
}

// 再帰的にディレクトリをトラバース
async function traverseDirectory(dirHandle, relativePath = '') {
    const items = [];
    let entryCount = 0;
    for await (const entry of dirHandle.values()) {
        entryCount++;
        // 進捗表示を更新（スロットリング付き）
        updateLoadingCount(entryCount);

        const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.kind === 'file') {
            if (isMediaFile(entry.name)) {
                const fileNode = {
                    kind: 'file',
                    name: entry.name,
                    path: entryPath,
                    handle: entry,
                    parentHandle: dirHandle
                };
                items.push(fileNode);
            }
        } else if (entry.kind === 'directory') {
            const subItems = await traverseDirectory(entry, entryPath);
            // 再生可能ファイルを含むサブフォルダのみをツリーに追加する
            if (subItems.length > 0) {
                items.push({
                    kind: 'directory',
                    name: entry.name,
                    path: entryPath,
                    handle: entry,
                    parentHandle: dirHandle,
                    children: subItems
                });
            }
        }
        // 大量エントリ時にUIが固まるのを防ぐため、定期的にイベントループに譲る
        if (entryCount % 50 === 0) {
            await yieldToUI();
        }
    }
    const order = await readFolderOrder(dirHandle);
    mergeFolderState(order);
    const sortedItems = sortTreeItems(items, order);
    if (!order) await writeFolderOrder(dirHandle, sortedItems, relativePath || null);
    return sortedItems;
}

function mergeFolderState(order) {
    if (!order) return;
    Object.assign(currentState.checkedFiles, order.checkedFiles || {});
    Object.assign(currentState.openFolders, order.openFolders || {});
    if (order.lastPlayedFile) currentState.lastPlayedFile = order.lastPlayedFile;
    if (typeof order.lastPlayedTime === 'number') currentState.lastPlayedTime = order.lastPlayedTime;
}

function sortTreeItems(items, order) {
    const orderMap = new Map((order?.items || []).map(item => [item.name, item.index]));
    return items.sort((a, b) => {
        const aIndex = orderMap.get(a.name);
        const bIndex = orderMap.get(b.name);
        if (aIndex !== undefined || bIndex !== undefined) {
            if (aIndex === undefined) return 1;
            if (bIndex === undefined) return -1;
            if (aIndex !== bIndex) return aIndex - bIndex;
        }
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
}

async function readFolderOrder(dirHandle) {
    if (!dirHandle?.getFileHandle) return null;
    try {
        const orderHandle = await dirHandle.getFileHandle(MUSIC_ORDER_FILE);
        const file = await orderHandle.getFile();
        const parsed = JSON.parse(await file.text());
        return Array.isArray(parsed.items) ? parsed : null;
    } catch (err) {
        if (err.name !== 'NotFoundError' && err.name !== 'TypeMismatchError') {
            console.warn('フォルダー順序の読み込みに失敗:', err);
        }
        return null;
    }
}

function getDirectState(source, folderPath, kind) {
    const result = {};
    for (const [path, value] of Object.entries(source || {})) {
        const parentPath = getParentFolderPath(path);
        if (parentPath === folderPath && (kind !== 'file' || value === true)) {
            result[path] = value;
        }
    }
    return result;
}

async function writeFolderOrder(dirHandle, items, folderPath = null, includePlayback = false) {
    if (!dirHandle?.getFileHandle) return;
    try {
        const orderHandle = await dirHandle.getFileHandle(MUSIC_ORDER_FILE, { create: true });
        const writable = await orderHandle.createWritable();
        const metadata = {
            version: 2,
            items: items.map((item, index) => ({ name: item.name, kind: item.kind, index })),
            checkedFiles: getDirectState(currentState.checkedFiles, folderPath, 'file'),
            openFolders: getDirectState(currentState.openFolders, folderPath, 'folder')
        };
        if (includePlayback) {
            metadata.lastPlayedFile = currentState.lastPlayedFile || null;
            metadata.lastPlayedTime = currentState.lastPlayedTime || 0;
        }
        await writable.write(JSON.stringify(metadata, null, 2));
        await writable.close();
    } catch (err) {
        console.warn('フォルダー順序の保存に失敗:', err);
    }
}

// ツリー表示順（深さ優先）でファイル一覧を生成 — 再生順と一覧順を一致させる
function flattenTreeFiles(items) {
    const result = [];
    for (const item of items) {
        if (item.kind === 'file') {
            result.push(item);
        } else if (item.kind === 'directory' && item.children) {
            result.push(...flattenTreeFiles(item.children));
        }
    }
    return result;
}

// プレイリストキューの更新
function updatePlaylistQueue() {
    playlistQueue = flatFiles.filter(file => {
        const isChecked = currentState.checkedFiles[file.path];
        // 明示的にチェックされた曲のみキューに含める（デフォルトはオフ）
        return isChecked === true;
    });
}

// 状態の保存（FSA / フォールバック共通）
function saveCurrentState() {
    const folderName = activeFolderName || directoryHandle?.name;
    if (!folderName) return;
    if (directoryHandle) {
        stateSavePromise = stateSavePromise.then(() => saveFolderMetadata()).catch(err => {
            console.warn('musics.json の状態保存に失敗:', err);
        });
        return;
    }
    const stateKey = `musicrunner_state_${folderName}`;
    localStorage.setItem(stateKey, JSON.stringify(currentState));
}

async function saveFolderMetadata() {
    await writeFolderOrder(directoryHandle, currentTreeItems, null, true);
    async function saveChildren(items) {
        for (const item of items) {
            if (item.kind === 'directory') {
                await writeFolderOrder(item.handle, item.children || [], item.path);
                await saveChildren(item.children || []);
            }
        }
    }
    await saveChildren(currentTreeItems);
}

function scheduleSaveCurrentState() {
    if (saveStateRaf) cancelAnimationFrame(saveStateRaf);
    saveStateRaf = requestAnimationFrame(() => {
        saveStateRaf = 0;
        saveCurrentState();
    });
}

function rebuildTreeIndex(items) {
    fileByPath = new Map();
    folderByPath = new Map();
    function walk(nodes) {
        for (const node of nodes) {
            if (node.kind === 'file') {
                fileByPath.set(node.path, node);
            } else if (node.kind === 'directory') {
                folderByPath.set(node.path, node);
                if (node.children) walk(node.children);
            }
        }
    }
    walk(items);
}

function getChildrenForPath(path) {
    if (!path) return currentTreeItems;
    return folderByPath.get(path)?.children || null;
}

function getFolderHandle(path) {
    if (!path) return directoryHandle;
    return folderByPath.get(path)?.handle || null;
}

function updateNodePaths(node, oldPrefix, newPrefix) {
    const oldPath = node.path;
    const nextPath = oldPath === oldPrefix
        ? newPrefix
        : `${newPrefix}${oldPath.substring(oldPrefix.length)}`;
    if (currentState.lastPlayedFile === oldPath) {
        currentState.lastPlayedFile = nextPath;
    }
    node.path = nextPath;

    if (currentState.checkedFiles[oldPath] !== undefined) {
        currentState.checkedFiles[nextPath] = currentState.checkedFiles[oldPath];
        delete currentState.checkedFiles[oldPath];
    }
    if (currentState.openFolders[oldPath] !== undefined) {
        currentState.openFolders[nextPath] = currentState.openFolders[oldPath];
        delete currentState.openFolders[oldPath];
    }

    if (node.children) {
        node.children.forEach(child => updateNodePaths(child, oldPrefix, newPrefix));
    }
}

function isDescendantPath(path, possibleParent) {
    if (!path || !possibleParent) return false;
    return path === possibleParent || path.startsWith(`${possibleParent}/`);
}

async function copyFileHandle(sourceHandle, targetDirectoryHandle, name) {
    const sourceFile = await sourceHandle.getFile();
    const targetHandle = await targetDirectoryHandle.getFileHandle(name, { create: true });
    const writable = await targetHandle.createWritable();
    await writable.write(sourceFile);
    await writable.close();
}

async function copyDirectoryHandle(sourceHandle, targetDirectoryHandle, name) {
    const targetHandle = await targetDirectoryHandle.getDirectoryHandle(name, { create: true });
    for await (const entry of sourceHandle.values()) {
        if (entry.kind === 'file') {
            await copyFileHandle(entry, targetHandle, entry.name);
        } else if (entry.kind === 'directory') {
            await copyDirectoryHandle(entry, targetHandle, entry.name);
        }
    }
}

async function moveHandleByCopy(sourceNode, targetDirectoryHandle) {
    const sourceHandle = sourceNode.handle;
    const sourceParentHandle = sourceNode.parentHandle;
    if (!sourceHandle || !sourceParentHandle || !targetDirectoryHandle) return false;

    if (sourceHandle.kind === 'file') {
        await copyFileHandle(sourceHandle, targetDirectoryHandle, sourceNode.name);
        await sourceParentHandle.removeEntry(sourceNode.name);
    } else {
        await copyDirectoryHandle(sourceHandle, targetDirectoryHandle, sourceNode.name);
        await sourceParentHandle.removeEntry(sourceNode.name, { recursive: true });
    }
    return true;
}

async function refreshNodeHandles(node) {
    if (!node.parentHandle) return;
    if (node.kind === 'file') {
        node.handle = await node.parentHandle.getFileHandle(node.name);
        return;
    }
    node.handle = await node.parentHandle.getDirectoryHandle(node.name);
    for (const child of node.children || []) {
        child.parentHandle = node.handle;
        await refreshNodeHandles(child);
    }
}

async function moveTreeNode(sourcePath, targetPath, { insertAfter = false } = {}) {
    const sourceNode = fileByPath.get(sourcePath) || folderByPath.get(sourcePath);
    const targetNode = fileByPath.get(targetPath) || folderByPath.get(targetPath);
    if (!sourceNode || !targetNode || sourceNode === targetNode) return;

    const sourceParentPath = getParentFolderPath(sourcePath);
    const targetParentPath = targetNode.kind === 'directory'
        ? targetNode.path
        : getParentFolderPath(targetPath);
    if (sourceNode.kind === 'directory' && isDescendantPath(targetParentPath, sourcePath)) return;

    const sourceChildren = getChildrenForPath(sourceParentPath);
    const targetChildren = getChildrenForPath(targetParentPath);
    if (!sourceChildren || !targetChildren) return;

    const sourceIndex = sourceChildren.indexOf(sourceNode);
    if (sourceIndex < 0) return;
    const sameParent = sourceParentPath === targetParentPath;
    let targetIndex = targetNode.kind === 'directory'
        ? targetChildren.length
        : targetChildren.indexOf(targetNode) + (insertAfter ? 1 : 0);
    if (targetIndex < 0) targetIndex = targetChildren.length;

    if (!sameParent && sourceNode.handle) {
        const targetHandle = getFolderHandle(targetParentPath);
        if (!targetHandle) return;
        try {
            if (typeof sourceNode.handle.move === 'function') {
                await sourceNode.handle.move(sourceNode.name, targetHandle);
            } else {
                await moveHandleByCopy(sourceNode, targetHandle);
            }
        } catch (err) {
            try {
                await moveHandleByCopy(sourceNode, targetHandle);
            } catch (copyErr) {
                console.warn('ファイルの移動に失敗:', copyErr);
                alert('ファイルを別フォルダーへ移動できませんでした。');
                return;
            }
        }
    }

    const previousPositions = new Map(
        Array.from(fileTreeContainer.querySelectorAll('.tree-row[data-path]')).map(row => [
            row.dataset.path,
            row.getBoundingClientRect().top
        ])
    );

    sourceChildren.splice(sourceIndex, 1);
    if (sameParent && sourceIndex < targetIndex) targetIndex--;
    targetChildren.splice(targetIndex, 0, sourceNode);

    if (!sameParent) {
        const newPath = targetParentPath ? `${targetParentPath}/${sourceNode.name}` : sourceNode.name;
        updateNodePaths(sourceNode, sourcePath, newPath);
        sourceNode.parentHandle = getFolderHandle(targetParentPath);
        if (sourceNode.handle) await refreshNodeHandles(sourceNode);
    }

    flatFiles = flattenTreeFiles(currentTreeItems);
    updatePlaylistQueue();
    renderFileTree(currentTreeItems);
    animateTreeReorder(previousPositions);
    scheduleSaveCurrentState();
}

function animateTreeReorder(previousPositions) {
    const rows = Array.from(fileTreeContainer.querySelectorAll('.tree-row[data-path]'));
    rows.forEach(row => {
        const previousTop = previousPositions.get(row.dataset.path);
        if (previousTop === undefined) return;
        const deltaY = previousTop - row.getBoundingClientRect().top;
        if (Math.abs(deltaY) < 1) return;
        row.style.transition = 'none';
        row.style.transform = `translateY(${deltaY}px)`;
    });
    requestAnimationFrame(() => {
        rows.forEach(row => {
            row.style.transition = '';
            row.style.transform = '';
        });
    });
}

function getParentFolderPath(filePath) {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? null : filePath.substring(0, idx);
}

function toggleFolderRow(row) {
    const path = row.dataset.path;
    const childrenDiv = row.nextElementSibling;
    if (!childrenDiv || !path) return;

    const isOpen = row.classList.contains('folder-open');
    if (isOpen) {
        row.classList.remove('folder-open');
        childrenDiv.style.display = 'none';
        currentState.openFolders[path] = false;
    } else {
        row.classList.add('folder-open');
        childrenDiv.style.display = 'flex';
        currentState.openFolders[path] = true;
    }
    scheduleSaveCurrentState();
}

// --- スクロール追従フォルダー名固定ヘッダー ---
function updateStickyFolderHeader() {
    const panelBody = document.getElementById('tree-panel-body');
    const stickyBar = document.getElementById('sticky-folder-bar');
    const stickyName = document.getElementById('sticky-folder-name');
    if (!panelBody || !stickyBar || !stickyName) return;

    // ルートフォルダーおよびサブフォルダーすべてのフォルダー行を取得
    const allFolderRows = Array.from(panelBody.querySelectorAll('.folder-row, .root-folder-row'));
    if (allFolderRows.length === 0) {
        stickyBar.classList.add('hidden');
        return;
    }

    const panelTop = panelBody.getBoundingClientRect().top;
    let activeFolderName = null;

    for (const row of allFolderRows) {
        const rowRect = row.getBoundingClientRect();

        // フォルダー行の上端がパネル上端よりも上にある（＝スクロールして上に隠れた/通り過ぎた）
        if (rowRect.top < panelTop + 10) {
            const treeNode = row.closest('.tree-node');
            if (treeNode) {
                // サブフォルダーの場合: そのフォルダーノード（配下の楽曲一覧）がまだ画面表示領域に残っているか
                const nodeRect = treeNode.getBoundingClientRect();
                if (nodeRect.bottom > panelTop + 30) {
                    const label = row.querySelector('.row-label');
                    if (label) {
                        activeFolderName = label.textContent.trim();
                    }
                }
            } else if (row.classList.contains('root-folder-row')) {
                // ルートフォルダー行の場合
                const label = row.querySelector('.row-label');
                if (label) {
                    activeFolderName = label.textContent.trim();
                }
            }
        }
    }

    if (activeFolderName) {
        stickyName.textContent = activeFolderName;
        stickyBar.classList.remove('hidden');
    } else {
        stickyBar.classList.add('hidden');
    }
}

function initFileTreeInteraction() {
    if (fileTreeContainer.dataset.interactionBound) return;
    fileTreeContainer.dataset.interactionBound = '1';

    const panelBody = document.getElementById('tree-panel-body');
    if (panelBody) {
        panelBody.addEventListener('scroll', updateStickyFolderHeader, { passive: true });
    }

    fileTreeContainer.addEventListener('click', (e) => {
        if (treeDragJustEnded) return;
        if (e.target.closest('.checkbox-container')) return;

        const row = e.target.closest('.tree-row');
        if (!row || row.dataset.rootBulk) return;

        if (row.classList.contains('folder-row')) {
            toggleFolderRow(row);
            setTimeout(updateStickyFolderHeader, 50);
        } else if (row.classList.contains('file-row')) {
            const node = fileByPath.get(row.dataset.path);
            if (node) {
                playNode(node);
                closeFileTreePanel();
            }
        }
    });

    fileTreeContainer.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' || e.button !== 0 || e.target.closest('.checkbox-container')) return;
        const row = e.target.closest('.tree-row');
        if (!row || row.dataset.rootBulk) return;

        touchDragState = {
            pointerId: e.pointerId,
            row,
            startX: e.clientX,
            startY: e.clientY,
            timer: setTimeout(() => beginTouchTreeDrag(), 450),
            active: false,
            nativeDraggable: row.draggable
        };
        row.draggable = false;
    });

    fileTreeContainer.addEventListener('pointermove', (e) => {
        if (!touchDragState || touchDragState.pointerId !== e.pointerId) return;
        const distance = Math.hypot(
            e.clientX - touchDragState.startX,
            e.clientY - touchDragState.startY
        );
        if (!touchDragState.active && distance > 14) {
            cancelTouchTreeDrag();
            return;
        }
        if (!touchDragState.active) return;

        e.preventDefault();
        const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tree-row');
        updateTouchDragTarget(row, e.clientY);
    });

    fileTreeContainer.addEventListener('pointerup', async (e) => {
        if (!touchDragState || touchDragState.pointerId !== e.pointerId) return;
        const state = touchDragState;
        const targetRow = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tree-row');
        if (state.active && targetRow && targetRow.dataset.path !== state.row.dataset.path) {
            await moveTreeNode(state.row.dataset.path, targetRow.dataset.path, {
                insertAfter: shouldInsertAfter(targetRow, e.clientY)
            });
            clearTreeDragState();
        } else {
            cancelTouchTreeDrag();
        }
    });

    fileTreeContainer.addEventListener('pointercancel', cancelTouchTreeDrag);

    fileTreeContainer.addEventListener('dragstart', (e) => {
        const row = e.target.closest('.tree-row');
        if (!row || row.dataset.rootBulk) return;
        draggedTreePath = row.dataset.path;
        row.classList.add('sortable-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedTreePath);
    });

    fileTreeContainer.addEventListener('dragover', (e) => {
        const row = e.target.closest('.tree-row');
        if (!draggedTreePath || !row || row.dataset.rootBulk || row.dataset.path === draggedTreePath) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        updateTouchDragTarget(row, e.clientY);
    });

    fileTreeContainer.addEventListener('drop', async (e) => {
        e.preventDefault();
        const row = e.target.closest('.tree-row');
        if (row && draggedTreePath && !row.dataset.rootBulk && row.dataset.path !== draggedTreePath) {
            await moveTreeNode(draggedTreePath, row.dataset.path, {
                insertAfter: shouldInsertAfter(row, e.clientY)
            });
        }
        clearTreeDragState();
    });

    fileTreeContainer.addEventListener('dragend', clearTreeDragState);
}

function beginTouchTreeDrag() {
    if (!touchDragState) return;
    touchDragState.active = true;
    draggedTreePath = touchDragState.row.dataset.path;
    touchDragState.row.classList.add('sortable-dragging');
    try {
        touchDragState.row.setPointerCapture(touchDragState.pointerId);
    } catch {}
    if (navigator.vibrate) navigator.vibrate(30);
}

function updateTouchDragTarget(row, clientY) {
    if (!draggedTreePath || !row || row.dataset.rootBulk || row.dataset.path === draggedTreePath) {
        if (dragOverRow) {
            dragOverRow.classList.remove('drag-over', 'drag-over-before', 'drag-over-after');
        }
        dragOverRow = null;
        return;
    }
    if (dragOverRow && dragOverRow !== row) {
        dragOverRow.classList.remove('drag-over', 'drag-over-before', 'drag-over-after');
    }
    dragOverRow = row;
    dragOverRow.classList.remove('drag-over-before', 'drag-over-after');
    dragOverRow.classList.add('drag-over');
    if (row.classList.contains('folder-row')) return;
    dragOverRow.classList.add(shouldInsertAfter(row, clientY) ? 'drag-over-after' : 'drag-over-before');
}

function cancelTouchTreeDrag() {
    if (!touchDragState) return;
    touchDragState.row.draggable = touchDragState.nativeDraggable;
    clearTimeout(touchDragState.timer);
    touchDragState = null;
    if (draggedTreePath) clearTreeDragState();
}

function clearTreeDragState() {
    document.querySelectorAll('.sortable-dragging, .drag-over').forEach(row => {
        row.classList.remove('sortable-dragging', 'drag-over', 'drag-over-before', 'drag-over-after');
    });
    if (touchDragState?.row) touchDragState.row.draggable = touchDragState.nativeDraggable;
    draggedTreePath = null;
    dragOverRow = null;
    if (touchDragState) {
        clearTimeout(touchDragState.timer);
        touchDragState = null;
    }
    treeDragJustEnded = true;
    setTimeout(() => {
        treeDragJustEnded = false;
    }, 0);
}

function shouldInsertAfter(row, clientY) {
    if (row.classList.contains('folder-row')) return false;
    const rect = row.getBoundingClientRect();
    return clientY > rect.top + rect.height / 2;
}

// --- チェックボックス一括操作（直下のファイルのみ） ---
function isFilePathChecked(path) {
    return currentState.checkedFiles[path] === true;
}

function getRootLevelFiles(items) {
    return items.filter(item => item.kind === 'file');
}

function getDirectFileChildren(folderNode) {
    if (!folderNode.children) return [];
    return folderNode.children.filter(child => child.kind === 'file');
}

function getBulkCheckState(fileNodes) {
    if (fileNodes.length === 0) {
        return { checked: false, indeterminate: false };
    }
    const checkedCount = fileNodes.filter(f => isFilePathChecked(f.path)).length;
    if (checkedCount === 0) return { checked: false, indeterminate: false };
    if (checkedCount === fileNodes.length) return { checked: true, indeterminate: false };
    return { checked: false, indeterminate: true };
}

function applyCheckboxInputState(input, state) {
    input.checked = state.checked;
    input.indeterminate = state.indeterminate;
    const container = input.closest('.checkbox-container');
    if (container) syncCheckboxAria(container, input);
}

function setFilesChecked(fileNodes, checked) {
    const affectedFolders = new Set();
    for (const file of fileNodes) {
        currentState.checkedFiles[file.path] = checked;
        const row = fileTreeContainer.querySelector(`.file-row[data-path="${CSS.escape(file.path)}"]`);
        const input = row?.querySelector('.checkbox-input');
        if (input) {
            input.checked = checked;
            input.indeterminate = false;
        }
        const parent = getParentFolderPath(file.path);
        if (parent) affectedFolders.add(parent);
    }
    scheduleSaveCurrentState();
    updatePlaylistQueue();
    scheduleBulkRefresh(affectedFolders);
}

function scheduleBulkRefresh(folderPaths) {
    if (!pendingBulkRefreshFolders) pendingBulkRefreshFolders = new Set();
    folderPaths.forEach(p => pendingBulkRefreshFolders.add(p));
    if (bulkRefreshRaf) return;
    bulkRefreshRaf = requestAnimationFrame(() => {
        bulkRefreshRaf = 0;
        const folders = pendingBulkRefreshFolders || new Set();
        pendingBulkRefreshFolders = null;
        refreshBulkCheckboxesForFolderPaths(folders);
    });
}

function refreshBulkCheckboxesForFolderPaths(folderPaths) {
    const rootInput = document.getElementById('root-bulk-checkbox');
    if (rootInput) {
        applyCheckboxInputState(rootInput, getBulkCheckState(getRootLevelFiles(currentTreeItems)));
    }
    for (const folderPath of folderPaths) {
        const folderNode = folderByPath.get(folderPath);
        if (!folderNode) continue;
        const folderInput = fileTreeContainer.querySelector(
            `.folder-bulk-checkbox[data-folder-path="${CSS.escape(folderPath)}"]`
        );
        if (folderInput) {
            applyCheckboxInputState(folderInput, getBulkCheckState(getDirectFileChildren(folderNode)));
        }
    }
}

function refreshBulkForFileChange(filePath) {
    const parent = getParentFolderPath(filePath);
    scheduleBulkRefresh(parent ? new Set([parent]) : new Set());
}

function toggleCheckboxInput(input, onToggle) {
    const checked = input.indeterminate ? true : !input.checked;
    input.checked = checked;
    input.indeterminate = false;
    onToggle(checked);
}

function createCheckboxControl({ variant = 'file', className, dataset, checked, indeterminate, onToggle }) {
    const cbContainer = document.createElement('div');
    cbContainer.className = `checkbox-container checkbox-container--${variant}`;
    cbContainer.setAttribute('role', 'button');
    cbContainer.setAttribute('aria-pressed', checked ? 'true' : 'false');
    if (variant === 'file') {
        cbContainer.title = '再生リストに含める';
    } else if (variant === 'root') {
        cbContainer.title = 'フォルダー直下のファイルをすべて選択';
    } else {
        cbContainer.title = 'このフォルダー直下のファイルをすべて選択';
    }

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = className || 'checkbox-input';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    if (dataset) {
        Object.entries(dataset).forEach(([key, value]) => {
            input.dataset[key] = value;
        });
    }
    applyCheckboxInputState(input, { checked, indeterminate });
    syncCheckboxAria(cbContainer, input);

    const customSpan = document.createElement('span');
    customSpan.className = `checkbox-custom checkbox-custom--${variant}`;

    cbContainer.appendChild(input);
    cbContainer.appendChild(customSpan);

    const stopEvent = (e) => {
        e.stopPropagation();
    };
    
    cbContainer.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleCheckboxInput(input, (newChecked) => {
            syncCheckboxAria(cbContainer, input);
            onToggle(newChecked);
        });
    });

    return { cbContainer, input };
}

function syncCheckboxAria(container, input) {
    if (input.indeterminate) {
        container.setAttribute('aria-pressed', 'mixed');
    } else {
        container.setAttribute('aria-pressed', input.checked ? 'true' : 'false');
    }
}

function createRootBulkRow(items) {
    const rootFiles = getRootLevelFiles(items);
    if (rootFiles.length === 0) return null;

    const rowDiv = document.createElement('div');
    rowDiv.className = 'tree-row root-folder-row';
    rowDiv.dataset.rootBulk = 'true';

    const iconDiv = document.createElement('div');
    iconDiv.className = 'row-icon';
    iconDiv.innerHTML = `
        <svg viewBox="0 0 24 24">
            <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" fill="currentColor"/>
        </svg>
    `;
    rowDiv.appendChild(iconDiv);

    const labelDiv = document.createElement('div');
    labelDiv.className = 'row-label';
    labelDiv.textContent = activeFolderName || 'フォルダー';
    rowDiv.appendChild(labelDiv);

    const bulkState = getBulkCheckState(rootFiles);
    const { cbContainer, input } = createCheckboxControl({
        variant: 'root',
        className: 'checkbox-input root-bulk-checkbox',
        dataset: {},
        checked: bulkState.checked,
        indeterminate: bulkState.indeterminate,
        onToggle: (checked) => setFilesChecked(rootFiles, checked)
    });
    input.id = 'root-bulk-checkbox';
    rowDiv.appendChild(cbContainer);

    return rowDiv;
}

// --- ツリーUIのレンダリング ---
function renderFileTree(items) {
    currentTreeItems = items;
    rebuildTreeIndex(items);
    fileTreeContainer.innerHTML = '';
    if (items.length === 0) {
        fileTreeContainer.innerHTML = '<div class="empty-tree-message">再生可能なファイルが見つかりません。</div>';
        return;
    }

    const fragment = document.createDocumentFragment();

    if (isFolderLoaded && activeFolderName) {
        const rootRow = createRootBulkRow(items);
        if (rootRow) fragment.appendChild(rootRow);
    }

    function createNodeElement(node) {
        const nodeDiv = document.createElement('div');
        nodeDiv.className = 'tree-node';

        const rowDiv = document.createElement('div');
        rowDiv.className = `tree-row ${node.kind === 'directory' ? 'folder-row' : 'file-row'}`;
        rowDiv.dataset.path = node.path;
        rowDiv.draggable = true;

        // 1. アイコン
        const iconDiv = document.createElement('div');
        iconDiv.className = 'row-icon';
        if (node.kind === 'directory') {
            iconDiv.classList.add('folder-icon-spin');
            iconDiv.innerHTML = `
                <svg viewBox="0 0 24 24">
                    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" fill="currentColor"/>
                </svg>
            `;
        } else {
            const isVid = isVideoFile(node.name);
            if (isVid) {
                iconDiv.innerHTML = `
                    <svg viewBox="0 0 24 24">
                        <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" fill="currentColor"/>
                    </svg>
                `;
            } else {
                iconDiv.innerHTML = `
                    <svg viewBox="0 0 24 24">
                        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" fill="currentColor"/>
                    </svg>
                `;
            }
        }
        rowDiv.appendChild(iconDiv);

        // 2. ファイル/フォルダ名
        const labelDiv = document.createElement('div');
        labelDiv.className = 'row-label';
        labelDiv.textContent = node.name;
        rowDiv.appendChild(labelDiv);

        // 3. 右側要素 (ファイル / フォルダのチェックボックス)
        if (node.kind === 'file') {
            const fileChecked = isFilePathChecked(node.path);
            const { cbContainer } = createCheckboxControl({
                variant: 'file',
                dataset: { path: node.path },
                checked: fileChecked,
                indeterminate: false,
                onToggle: (checked) => {
                    currentState.checkedFiles[node.path] = checked;
                    scheduleSaveCurrentState();
                    updatePlaylistQueue();
                    refreshBulkForFileChange(node.path);
                }
            });
            rowDiv.appendChild(cbContainer);
        } else {
            const directFiles = getDirectFileChildren(node);
            if (directFiles.length > 0) {
                const bulkState = getBulkCheckState(directFiles);
                const { cbContainer } = createCheckboxControl({
                    variant: 'folder',
                    className: 'checkbox-input folder-bulk-checkbox',
                    dataset: { folderPath: node.path },
                    checked: bulkState.checked,
                    indeterminate: bulkState.indeterminate,
                    onToggle: (checked) => setFilesChecked(directFiles, checked)
                });
                rowDiv.appendChild(cbContainer);
            }
        }

        nodeDiv.appendChild(rowDiv);

        // 子階層がある場合 (フォルダ)
        if (node.kind === 'directory' && node.children) {
            const childrenDiv = document.createElement('div');
            childrenDiv.className = 'tree-children';
            
            // フォルダの開閉状態を復元
            const isFolderOpen = currentState.openFolders[node.path] === true;
            if (isFolderOpen) {
                rowDiv.classList.add('folder-open');
                childrenDiv.style.display = 'flex';
            } else {
                childrenDiv.style.display = 'none';
            }

            node.children.forEach(child => {
                childrenDiv.appendChild(createNodeElement(child));
            });
            nodeDiv.appendChild(childrenDiv);
        }

        return nodeDiv;
    }

    items.forEach(item => {
        fragment.appendChild(createNodeElement(item));
    });
    fileTreeContainer.appendChild(fragment);

    // 現在再生中の行をハイライト
    highlightPlayingRow();
    setTimeout(updateStickyFolderHeader, 0);
}

// 再生中のファイル行のハイライト
function highlightPlayingRow() {
    document.querySelectorAll('.file-row').forEach(row => {
        row.classList.remove('playing-row');
        if (currentPlayingFile && row.dataset.path === currentPlayingFile.path) {
            row.classList.add('playing-row');
        }
    });
}

// --- メディアの再生処理 ---
// autoPlay: false の場合はロードのみ行い再生しない（フォルダ読み込み時の復元用）
// seekTime: 指定された場合はロード後にその位置へシークする
async function playNode(node, { autoPlay = true, seekTime = null } = {}) {
    if (!node) return;

    try {
        let file;
        // フォールバック (input要素) で取得したファイルは node.file に入っている
        // File System Access API で取得したファイルは node.handle.getFile() で取得する
        // ※ node.handle が undefined の場合に .getFile を参照するとクラッシュするため先に node.file を確認
        if (node.file) {
            file = node.file;
        } else if (node.handle && typeof node.handle.getFile === 'function') {
            file = await node.handle.getFile();
        }

        if (!file) {
            console.warn('playNode: ファイルを取得できませんでした', node);
            return;
        }

        currentPlayingFile = node;
        highlightPlayingRow();

        // 以前のオブジェクトURLを解放
        if (mainVideo.src) {
            URL.revokeObjectURL(mainVideo.src);
        }

        const objectURL = URL.createObjectURL(file);
        mainVideo.src = objectURL;

        // シーク位置の復元（loadedmetadata 待ち）
        if (seekTime !== null && seekTime > 0) {
            const onLoaded = () => {
                try {
                    mainVideo.currentTime = seekTime;
                } catch (e) {
                    console.warn('Seek failed:', e);
                }
                mainVideo.removeEventListener('loadedmetadata', onLoaded);
            };
            mainVideo.addEventListener('loadedmetadata', onLoaded);
        }

        // UI表示の設定
        const isVid = isVideoFile(node.name);
        if (isVid) {
            musicPlaceholder.classList.remove('active');
            mainVideo.style.display = 'block';
        } else {
            musicPlaceholder.classList.add('active');
            mainVideo.style.display = 'none';
            // メディア情報更新
            currentTitle.textContent = node.name.substring(0, node.name.lastIndexOf('.')) || node.name;
            currentArtist.textContent = node.path.includes('/') ? node.path.substring(0, node.path.lastIndexOf('/')) : 'Local Folder';
        }

        updateMediaSession(node);

        if (autoPlay) {
            playMedia();
        } else {
            // 自動再生しない場合は一時停止状態のUIにする
            iconPlay.classList.remove('hidden');
            iconPause.classList.add('hidden');
            musicPlaceholder.classList.remove('playing');
        }
    } catch (err) {
        console.error('Play node error:', err);
    }
}

// --- 再生位置の保存・復元 ---
let savePositionRaf = 0;

function savePlaybackPosition() {
    if (!currentPlayingFile) return;
    const folderName = activeFolderName || directoryHandle?.name;
    if (!folderName) return;
    currentState.lastPlayedFile = currentPlayingFile.path;
    currentState.lastPlayedTime = mainVideo.currentTime || 0;
    scheduleSaveCurrentState();
}

function scheduleSavePlaybackPosition() {
    if (savePositionRaf) return;
    savePositionRaf = requestAnimationFrame(() => {
        savePositionRaf = 0;
        savePlaybackPosition();
    });
}

// フォルダ読み込み後の再生復元処理
// チェックされた曲があれば前回再生位置から再開（自動再生なし）
// チェックされた曲がなければ「選択されていません」を表示
function restorePlayback() {
    if (playlistQueue.length > 0) {
        // 前回再生していたファイルをキューから探す
        const lastPath = currentState.lastPlayedFile;
        const lastTime = currentState.lastPlayedTime || 0;
        let targetNode = null;

        if (lastPath) {
            targetNode = playlistQueue.find(f => f.path === lastPath);
        }
        // 見つからなければキューの最初の曲
        if (!targetNode) {
            targetNode = playlistQueue[0];
        }

        // ロードのみ（自動再生なし）、シーク位置あり
        playNode(targetNode, { autoPlay: false, seekTime: lastTime });
    } else if (flatFiles.length > 0) {
        // チェックされた曲がない場合は「選択されていません」を表示
        showNoSelectionMessage();
    } else {
        // メディアファイル自体が存在しない
        showNoSelectionMessage();
    }
}

// 「選択されていません」メッセージを表示
function showNoSelectionMessage() {
    currentPlayingFile = null;
    highlightPlayingRow();
    musicPlaceholder.classList.add('active');
    musicPlaceholder.classList.remove('playing');
    mainVideo.style.display = 'none';
    if (mainVideo.src) {
        URL.revokeObjectURL(mainVideo.src);
        mainVideo.removeAttribute('src');
        mainVideo.load();
    }
    currentTitle.textContent = '選択されていません';
    iconPlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
}

// 再生終了時のロジック
function handlePlaybackEnded() {
    // 再生中のファイルがない場合は何もしない（選択されていません表示中の誤発火を防ぐ）
    if (!currentPlayingFile) return;
    if (loopMode === 'single') {
        // 単一曲ループ: 再度同じ曲を再生
        mainVideo.currentTime = 0;
        playMedia();
    } else {
        // プレイリストループ: チェックされたファイルを順次再生
        if (playlistQueue.length === 0) {
            pauseMedia();
            return;
        }
        playNextFile();
    }
}

function playNextFile() {
    if (playlistQueue.length === 0) return;
    let nextIndex = 0;
    if (currentPlayingFile) {
        const currentIndex = playlistQueue.findIndex(f => f.path === currentPlayingFile.path);
        if (currentIndex !== -1) {
            nextIndex = currentIndex + 1;
            if (nextIndex >= playlistQueue.length) {
                nextIndex = 0; // ループして最初に戻る
            }
        }
    }
    playNode(playlistQueue[nextIndex]);
}

function playPreviousFile() {
    if (playlistQueue.length === 0) return;
    let prevIndex = playlistQueue.length - 1;
    if (currentPlayingFile) {
        const currentIndex = playlistQueue.findIndex(f => f.path === currentPlayingFile.path);
        if (currentIndex !== -1) {
            prevIndex = currentIndex - 1;
            if (prevIndex < 0) {
                prevIndex = playlistQueue.length - 1;
            }
        }
    }
    playNode(playlistQueue[prevIndex]);
}

function setupMediaSession() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', playMedia);
        navigator.mediaSession.setActionHandler('pause', pauseMedia);
        navigator.mediaSession.setActionHandler('previoustrack', playPreviousFile);
        navigator.mediaSession.setActionHandler('nexttrack', playNextFile);
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.fastSeek && ('fastSeek' in mainVideo)) {
                mainVideo.fastSeek(details.seekTime);
            } else {
                mainVideo.currentTime = details.seekTime;
            }
        });
    }
}

function updateMediaSession(node) {
    if ('mediaSession' in navigator) {
        const title = node.name.substring(0, node.name.lastIndexOf('.')) || node.name;
        const artist = node.path.includes('/') ? node.path.substring(0, node.path.lastIndexOf('/')) : 'Local Folder';
        const metadataInit = {
            title: title,
            artist: artist,
            album: 'Music Runner'
        };

        // file:// プロトコルでは相対パスの画像読み込みがエラーになるため除外する
        if (window.location.protocol !== 'file:') {
            metadataInit.artwork = [
                { src: 'icons/icon_192_1779500783783.png', sizes: '192x192', type: 'image/png' },
                { src: 'icons/icon_512_1779500897773.png', sizes: '512x512', type: 'image/png' }
            ];
        }

        try {
            navigator.mediaSession.metadata = new MediaMetadata(metadataInit);
        } catch (e) {
            console.warn('Failed to set MediaMetadata:', e);
        }
    }
}

// --- フォールバック処理 (File System Access API 未サポートブラウザ用) ---
function handleFallbackFiles(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    isFolderLoaded = false;

    flatFiles = files.filter(f => isMediaFile(f.name)).map(f => ({
        kind: 'file',
        name: f.name,
        path: f.name,
        file: f
    }));

    playlistQueue = [...flatFiles];

    if (playlistQueue.length > 0) {
        showScreen('play');
        playNode(playlistQueue[0]);
    }
}

async function handleFallbackFolder(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    isFolderLoaded = true;

    // Determine top-level folder name
    let folderName = 'Local Folder';
    if (files[0].webkitRelativePath) {
        folderName = files[0].webkitRelativePath.split('/')[0];
    }

    // 読み込みオーバーレイを表示（描画のためにイベントループに譲る）
    showLoading(`「${folderName}」を読み込んでいます`);
    loadingStatus.textContent = `${files.length} 個のファイルを処理中...`;
    await yieldToUI();

    try {
        // Load saved UI state if exists
        const stateKey = `musicrunner_state_${folderName}`;
        const savedState = localStorage.getItem(stateKey);
        if (savedState) {
            currentState = JSON.parse(savedState);
        } else {
            currentState = { openFolders: {}, checkedFiles: {} };
        }

        // 同一セッション内の「前回のフォルダー」用（File オブジェクトは永続化不可）
        cachedFolderFiles = files.filter(f => isMediaFile(f.name));
        directoryHandle = null;
        saveLastFolderMeta(folderName, 'fallback');
        updateLastFolderButton();

        // Build tree structure and render UI
        const treeData = buildFallbackTree(files, folderName);
        flatFiles = flattenTreeFiles(treeData);

        // Populate playlist from the cached files
        updatePlaylistQueue();

        renderFileTree(treeData);

        showScreen('play');

        // 読み込み完了: オーバーレイを閉じる
        hideLoading();

        // 自動再生せず、チェック状態に応じて復元 or 「選択されていません」表示
        restorePlayback();
    } catch (err) {
        console.error('handleFallbackFolder error:', err);
        showLoadingError('フォルダーの読み込み中にエラーが発生しました');
    }
}

// webkitRelativePath からツリー構造を作成する
function buildFallbackTree(files, rootName) {
    const rootNode = {
        name: rootName,
        kind: 'directory',
        path: rootName,
        children: []
    };

    const mediaFiles = files.filter(f => isMediaFile(f.name));

    mediaFiles.forEach(file => {
        const pathParts = file.webkitRelativePath.split('/');
        // 最初の要素はルートフォルダ名
        pathParts.shift();

        let currentLevel = rootNode.children;
        let currentPath = rootName;

        pathParts.forEach((part, index) => {
            currentPath += '/' + part;
            const isLast = index === pathParts.length - 1;

            if (isLast) {
                const fileNode = {
                    kind: 'file',
                    name: part,
                    path: currentPath,
                    file: file
                };
                currentLevel.push(fileNode);
            } else {
                let folder = currentLevel.find(item => item.kind === 'directory' && item.name === part);
                if (!folder) {
                    folder = {
                        kind: 'directory',
                        name: part,
                        path: currentPath,
                        children: []
                    };
                    currentLevel.push(folder);
                }
                currentLevel = folder.children;
            }
        });
    });

    // 空のフォルダノードを除去しソート
    function cleanAndSort(nodeList) {
        const filtered = nodeList.filter(item => {
            if (item.kind === 'directory') {
                cleanAndSort(item.children);
                return item.children.length > 0;
            }
            return true;
        });
        // フォルダー → ファイルの順で、それぞれa-z
        filtered.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
        return filtered;
    }

    return cleanAndSort(rootNode.children);
}

// --- スワイプジェスチャー制御 ---
let touchStartY = 0;
let touchCurrentY = 0;
let isDragging = false;
let panelHeight = 0;

function initSwipeGestures() {
    const mediaArea = document.getElementById('media-area');
    const panelHeader = document.querySelector('.panel-header');
    const panelBody = document.querySelector('.panel-body');

    // 1. メディアエリアを下にスワイプしてファイルツリーを開く
    mediaArea.addEventListener('touchstart', (e) => {
        if (!isFolderLoaded) return;
        touchStartY = e.touches[0].clientY;
        panelHeight = fileTreePanel.offsetHeight || (window.innerHeight * 0.8);
    }, { passive: true });

    mediaArea.addEventListener('touchmove', (e) => {
        if (!isFolderLoaded) return;
        touchCurrentY = e.touches[0].clientY;
        const diff = touchCurrentY - touchStartY;

        if (diff > 10 && !fileTreePanel.classList.contains('open')) {
            isDragging = true;
            fileTreePanel.classList.add('no-transition');
            const ty = Math.min(0, -panelHeight + diff);
            fileTreePanel.style.transform = `translateY(${ty}px)`;
        }
    }, { passive: true });

    mediaArea.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        fileTreePanel.classList.remove('no-transition');
        const diff = touchCurrentY - touchStartY;

        // 60px 以上スワイプすれば開く（以前は 1/3 パネル高さ ≒ 200px 必要だった）
        if (diff > 60) {
            openFileTreePanel();
        } else {
            closeFileTreePanel();
        }
    });

    // 2. パネルヘッダー（ドラッグバー）を上にスワイプして閉じる
    function startClose(e) {
        touchStartY = e.touches[0].clientY;
        panelHeight = fileTreePanel.offsetHeight;
        fileTreePanel.classList.add('no-transition');
    }
    function moveClose(e) {
        touchCurrentY = e.touches[0].clientY;
        const diff = touchCurrentY - touchStartY;
        if (fileTreePanel.classList.contains('open')) {
            const ty = Math.min(0, diff);
            fileTreePanel.style.transform = `translateY(${ty}px)`;
        }
    }
    function endClose() {
        fileTreePanel.classList.remove('no-transition');
        const diff = touchCurrentY - touchStartY;
        // 50px 以上上にスワイプすれば閉じる
        if (diff < -50) {
            closeFileTreePanel();
        } else {
            openFileTreePanel();
        }
    }

    panelHeader.addEventListener('touchstart', startClose, { passive: true });
    panelHeader.addEventListener('touchmove', moveClose, { passive: true });
    panelHeader.addEventListener('touchend', endClose);


}

function openFileTreePanel() {
    fileTreePanel.classList.add('open');
    fileTreePanel.style.transform = 'translateY(0)';
}

function closeFileTreePanel() {
    fileTreePanel.classList.remove('open');
    fileTreePanel.style.transform = 'translateY(-100%)';
}

// --- Web Audio API エフェクト ---
let audioCtx = null;
let sourceNode = null;
let bassNode = null;
let trebleNode = null;
let distortionNode = null;
let reverbConvolver = null;
let reverbGain = null;
let dryGain = null;
let compressor = null;
let analyser = null;
let visualizerCanvas = null;
let visualizerCtx = null;
const VISUALIZER_SETTINGS_KEY = 'musicrunner_visualizer_settings';
const visualizerSettings = {
    enabled: true,
    mode: 'bars',
    palette: 'violet',
    energy: 35
};

const visualizerPalettes = {
    violet: ['203, 191, 252', '168, 153, 230', '100, 82, 180'],
    aqua: ['190, 255, 247', '64, 211, 198', '23, 125, 145'],
    sunset: ['255, 224, 173', '255, 145, 94', '190, 65, 92'],
    mono: ['255, 255, 255', '190, 190, 205', '100, 100, 120']
};

function initAudioEffects() {
    if (audioCtx) return; // すでに初期化されていればスキップ
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    audioCtx = new AudioContext();
    sourceNode = audioCtx.createMediaElementSource(mainVideo);

    bassNode = audioCtx.createBiquadFilter();
    bassNode.type = 'lowshelf';
    bassNode.frequency.value = 200;
    
    trebleNode = audioCtx.createBiquadFilter();
    trebleNode.type = 'highshelf';
    trebleNode.frequency.value = 3000;

    distortionNode = audioCtx.createWaveShaper();
    distortionNode.curve = new Float32Array([-1, 1]); // linear curve to avoid silence bug
    distortionNode.oversample = '4x';

    // リバーブ用の並列ルーティング
    reverbConvolver = audioCtx.createConvolver();
    reverbConvolver.buffer = createReverbBuffer(audioCtx, 2.5, 2.0); // 2.5秒の残響
    
    reverbGain = audioCtx.createGain();
    reverbGain.gain.value = 0; // 初期はリバーブなし

    dryGain = audioCtx.createGain();
    dryGain.gain.value = 1;

    compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 30;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024; // 512 bins for ultra-smooth full-width visualizer
    analyser.smoothingTimeConstant = 0.6; // 0(即時) 〜 1(ゆっくり)。デフォルト0.8より速く反応させる

    // 接続: Source -> Bass -> Treble -> Distortion -> (Dry / Reverb) -> Compressor -> Destination
    sourceNode.connect(bassNode);
    bassNode.connect(trebleNode);
    trebleNode.connect(distortionNode);

    // Dry (原音)
    distortionNode.connect(dryGain);
    dryGain.connect(compressor);

    // Wet (リバーブ)
    distortionNode.connect(reverbConvolver);
    reverbConvolver.connect(reverbGain);
    reverbGain.connect(compressor);

    compressor.connect(analyser);
    analyser.connect(audioCtx.destination);

    // ビジュアライザーの描画開始
    visualizerCanvas = document.getElementById('visualizer-canvas');
    if (visualizerCanvas) {
        visualizerCtx = visualizerCanvas.getContext('2d');
        resizeVisualizer();
        window.addEventListener('resize', resizeVisualizer);
        drawVisualizer();
    }

    // 初期化直後にUIスライダー（または復元された設定）の値をエフェクトノードに反映
    updateAudioEffects();
}

function resizeVisualizer() {
    if (!visualizerCanvas) return;
    visualizerCanvas.width = visualizerCanvas.clientWidth;
    visualizerCanvas.height = visualizerCanvas.clientHeight;
}

// スケール（最大値制限）を滑らかに変化させるための状態
let smoothCurrentScale = 1;
let smoothedVisualizerValues = [];

function getVisualizerDynamics() {
    const energy = visualizerSettings.energy / 100;
    return {
        sensitivity: 70 + energy * 90,
        response: 0.2 + energy * 0.6,
        recovery: 0.1 + energy * 0.6
    };
}

function drawVisualizer() {
    if (!analyser || !visualizerCtx) return;
    requestAnimationFrame(drawVisualizer);

    const allBins = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(allBins);
    analyser.getByteFrequencyData(dataArray);

    const w = visualizerCanvas.width;
    const h = visualizerCanvas.height;

    visualizerCtx.clearRect(0, 0, w, h);

    // 画面幅 w に応じてバーの本数を動的に決定（画面横幅全体に美しく展開）
    if (!visualizerSettings.enabled) {
        visualizerCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
        return;
    }

    const barWidth = 10;
    const gap = 4;
    const unit = barWidth + gap;
    const barCount = Math.max(16, Math.floor((w - gap) / unit));
    const totalWidth = barCount * unit - gap;
    let x = (w - totalWidth) / 2;

    // 下位60%の周波数帯を使用
    const useBins = Math.floor(allBins * 0.6);
    const maxUseIndex = Math.max(1, useBins - 1);

    const bars = [];
    const dynamics = getVisualizerDynamics();
    for (let i = 0; i < barCount; i++) {
        const binPos = (barCount > 1) ? (i / (barCount - 1)) * maxUseIndex : 0;
        const index = Math.floor(binPos);
        const fraction = binPos - index;
        
        let val;
        if (index >= maxUseIndex) {
            val = dataArray[maxUseIndex];
        } else {
            val = dataArray[index] * (1 - fraction) + dataArray[index + 1] * fraction;
        }
        const targetValue = val * (dynamics.sensitivity / 100);
        const previousValue = smoothedVisualizerValues[i] || 0;
        const smoothing = targetValue > previousValue
            ? dynamics.response
            : dynamics.recovery;
        const smoothedValue = previousValue + (targetValue - previousValue) * smoothing;
        smoothedVisualizerValues[i] = smoothedValue;
        bars.push(smoothedValue);
    }

    const palette = visualizerPalettes[visualizerSettings.palette] || visualizerPalettes.violet;
    if (visualizerSettings.mode === 'aurora') {
        drawAuroraVisualizer(bars, w, h, palette);
        return;
    }

    // 最大高さを全体の45%に制限
    const maxBarHeight = h * 0.45;
    const maxVal = Math.max(...bars, 1);
    const targetScale = Math.min(1, (maxBarHeight * 255) / (maxVal * h));

    if (targetScale < smoothCurrentScale) {
        smoothCurrentScale = targetScale;
    } else {
        smoothCurrentScale += (targetScale - smoothCurrentScale) * 0.015; // ゆっくり戻す
    }

    for (let i = 0; i < barCount; i++) {
        const rawHeight = (bars[i] / 255) * h * smoothCurrentScale;
        const barHeight = Math.min(rawHeight, maxBarHeight);
        const barTop = h - barHeight;
        const t = bars[i] / 255;

        // グラデーション
        const grad = visualizerCtx.createLinearGradient(0, barTop, 0, h);
        grad.addColorStop(0, `rgba(${palette[0]}, ${0.9 * t})`);
        grad.addColorStop(0.5, `rgba(${palette[1]}, ${0.7 * t})`);
        grad.addColorStop(1, `rgba(${palette[2]}, ${0.4 * t})`);

        visualizerCtx.save();
        visualizerCtx.shadowColor = `rgba(${palette[1]}, ${0.6 * t})`;
        visualizerCtx.shadowBlur = 10 + t * 12;
        visualizerCtx.fillStyle = grad;

        // 上部を丸くする
        const radius = barWidth / 2;
        if (barHeight > radius * 2) {
            visualizerCtx.beginPath();
            visualizerCtx.moveTo(x, h);
            visualizerCtx.lineTo(x, barTop + radius);
            visualizerCtx.arcTo(x, barTop, x + radius, barTop, radius);
            visualizerCtx.arcTo(x + barWidth, barTop, x + barWidth, barTop + radius, radius);
            visualizerCtx.lineTo(x + barWidth, h);
            visualizerCtx.closePath();
            visualizerCtx.fill();
        } else if (barHeight > 0) {
            visualizerCtx.fillRect(x, barTop, barWidth, barHeight);
        }

        visualizerCtx.restore();
        x += unit;
    }
}

function drawAuroraVisualizer(values, width, height, palette) {
    const baseline = height * 0.92;
    const maxAmplitude = height * 0.62;
    const peak = Math.max(...values, 1);
    const points = values.map((value, index) => ({
        x: values.length === 1 ? width / 2 : (index / (values.length - 1)) * width,
        y: baseline - (value / peak) * maxAmplitude
    }));

    const fill = visualizerCtx.createLinearGradient(0, 0, 0, baseline);
    fill.addColorStop(0, `rgba(${palette[0]}, 0.42)`);
    fill.addColorStop(0.45, `rgba(${palette[1]}, 0.18)`);
    fill.addColorStop(1, `rgba(${palette[2]}, 0)`);

    visualizerCtx.save();
    visualizerCtx.beginPath();
    visualizerCtx.moveTo(0, baseline);
    visualizerCtx.lineTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1];
        const current = points[i];
        const midpointX = (previous.x + current.x) / 2;
        const midpointY = (previous.y + current.y) / 2;
        visualizerCtx.quadraticCurveTo(previous.x, previous.y, midpointX, midpointY);
    }
    const lastPoint = points[points.length - 1];
    visualizerCtx.lineTo(lastPoint.x, lastPoint.y);
    visualizerCtx.lineTo(width, baseline);
    visualizerCtx.closePath();
    visualizerCtx.fillStyle = fill;
    visualizerCtx.fill();

    visualizerCtx.beginPath();
    visualizerCtx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1];
        const current = points[i];
        const midpointX = (previous.x + current.x) / 2;
        const midpointY = (previous.y + current.y) / 2;
        visualizerCtx.quadraticCurveTo(previous.x, previous.y, midpointX, midpointY);
    }
    visualizerCtx.lineTo(lastPoint.x, lastPoint.y);
    visualizerCtx.strokeStyle = `rgba(${palette[0]}, 0.92)`;
    visualizerCtx.lineWidth = 1.5;
    visualizerCtx.shadowColor = `rgba(${palette[1]}, 0.85)`;
    visualizerCtx.shadowBlur = 14;
    visualizerCtx.stroke();
    visualizerCtx.restore();
}



function makeDistortionCurve(amount) {
    if (amount === 0) return new Float32Array([-1, 1]); // linear curve (no distortion)
    const k = amount;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
        let x = i * 2 / n_samples - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

function createReverbBuffer(ctx, duration, decay) {
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * duration;
    const impulse = ctx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);
    for (let i = 0; i < length; i++) {
        const factor = Math.pow(1 - i / length, decay);
        left[i] = (Math.random() * 2 - 1) * factor;
        right[i] = (Math.random() * 2 - 1) * factor;
    }
    return impulse;
}

function updateAudioEffects() {
    if (!audioCtx) return;
    const bass = parseFloat(document.getElementById('slider-bass').value);
    const treble = parseFloat(document.getElementById('slider-treble').value);
    const dist = parseFloat(document.getElementById('slider-distortion').value);
    const rev = parseFloat(document.getElementById('slider-reverb').value);

    bassNode.gain.value = bass;
    trebleNode.gain.value = treble;
    
    // dist は 0〜100
    distortionNode.curve = makeDistortionCurve(dist);

    // rev は 0〜100
    const revMix = rev / 100;
    reverbGain.gain.value = revMix * 1.5;
    // dry信号は少し下げる（全体の音量を保つため）
    dryGain.gain.value = 1 - (revMix * 0.3);
}

// プリセット設定は audio-presets.js で管理 (window.audioPresets)

function applyEffectPreset(presetId) {
    const presets = window.audioPresets || [];
    let p = presets.find(item => item.id === presetId);
    if (!p) {
        // 見つからない場合は最初のプリセットか、オール0のフォールバック
        p = presets.length > 0 ? presets[0] : { bass: 0, treble: 0, dist: 0, rev: 0 };
    }
    document.getElementById('slider-bass').value = p.bass;
    document.getElementById('slider-treble').value = p.treble;
    document.getElementById('slider-distortion').value = p.dist;
    document.getElementById('slider-reverb').value = p.rev;
    
    document.getElementById('val-bass').textContent = p.bass + ' dB';
    document.getElementById('val-treble').textContent = p.treble + ' dB';
    document.getElementById('val-distortion').textContent = p.dist + ' %';
    document.getElementById('val-reverb').textContent = p.rev + ' %';
    
    updateAudioEffects();
    saveAudioSettings();
}

const AUDIO_SETTINGS_KEY = 'musicrunner_audio_settings';

function saveAudioSettings() {
    const presetSelect = document.getElementById('effect-preset');
    if (!presetSelect) return;
    const settings = {
        preset: presetSelect.value,
        bass: parseFloat(document.getElementById('slider-bass').value),
        treble: parseFloat(document.getElementById('slider-treble').value),
        dist: parseFloat(document.getElementById('slider-distortion').value),
        rev: parseFloat(document.getElementById('slider-reverb').value)
    };
    try {
        localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn('Failed to save audio settings:', e);
    }
}

function loadAudioSettings() {
    try {
        const raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
        if (!raw) return;
        const settings = JSON.parse(raw);

        document.getElementById('slider-bass').value = settings.bass ?? 0;
        document.getElementById('slider-treble').value = settings.treble ?? 0;
        document.getElementById('slider-distortion').value = settings.dist ?? 0;
        document.getElementById('slider-reverb').value = settings.rev ?? 0;

        document.getElementById('val-bass').textContent = (settings.bass ?? 0) + ' dB';
        document.getElementById('val-treble').textContent = (settings.treble ?? 0) + ' dB';
        document.getElementById('val-distortion').textContent = (settings.dist ?? 0) + ' %';
        document.getElementById('val-reverb').textContent = (settings.rev ?? 0) + ' %';

        const presetSelect = document.getElementById('effect-preset');
        if (presetSelect) {
            presetSelect.value = settings.preset ?? 'normal';
        }
    } catch (e) {
        console.warn('Failed to load audio settings:', e);
    }
}

// --- エフェクトUI のイベントリスナー設定 ---
function initEffectsUI() {
    const btnEffects = document.getElementById('btn-effects');
    const effectsPanel = document.getElementById('effects-panel');
    const dragHeader = document.getElementById('effects-drag-header');
    
    // オプションを動的に追加
    const presetSelect = document.getElementById('effect-preset');
    presetSelect.innerHTML = ''; // 念のためクリア
    
    if (window.audioPresets) {
        window.audioPresets.forEach(preset => {
            const opt = document.createElement('option');
            opt.value = preset.id;
            opt.textContent = preset.name;
            presetSelect.appendChild(opt);
        });
    }

    // オプションに Custom を追加
    const customOption = document.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = 'Custom';
    customOption.style.display = 'none';
    presetSelect.appendChild(customOption);
    
    // UIスライダーのイベント
    ['bass', 'treble', 'distortion', 'reverb'].forEach(key => {
        const slider = document.getElementById('slider-' + key);
        const val = document.getElementById('val-' + key);
        slider.addEventListener('input', () => {
            const unit = (key === 'bass' || key === 'treble') ? ' dB' : ' %';
            val.textContent = slider.value + unit;
            presetSelect.value = 'custom';
            updateAudioEffects();
            saveAudioSettings();
        });
    });

    presetSelect.addEventListener('change', (e) => {
        if (e.target.value !== 'custom') {
            applyEffectPreset(e.target.value);
        } else {
            saveAudioSettings();
        }
    });

    // パネルの開閉 (トグル)
    btnEffects.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (effectsPanel.classList.contains('open')) {
            effectsPanel.classList.remove('open');
            effectsPanel.style.transform = 'translateX(100%)';
        } else {
            effectsPanel.classList.add('open');
            effectsPanel.style.transform = 'translateX(0)';
        }
    });

    // スワイプで閉じる (右にスワイプ)
    let ex = 0, currX = 0;
    dragHeader.addEventListener('touchstart', (e) => {
        ex = e.touches[0].clientX;
        effectsPanel.classList.add('no-transition');
    }, { passive: true });
    
    dragHeader.addEventListener('touchmove', (e) => {
        currX = e.touches[0].clientX;
        const diff = currX - ex;
        if (effectsPanel.classList.contains('open')) {
            // 右スワイプ(正の値)のみ許可
            const tx = Math.max(0, diff);
            effectsPanel.style.transform = `translateX(${tx}px)`;
        }
    }, { passive: true });
    
    dragHeader.addEventListener('touchend', () => {
        effectsPanel.classList.remove('no-transition');
        const diff = currX - ex;
        if (diff > 50) {
            effectsPanel.classList.remove('open');
            effectsPanel.style.transform = 'translateX(100%)';
        } else {
            effectsPanel.style.transform = 'translateX(0)';
        }
    });

    // 保存されていたエフェクト設定をUIに復元
    loadAudioSettings();
}

function initVisualizerSettingsUI() {
    const button = document.getElementById('btn-visualizer-settings');
    const panel = document.getElementById('visualizer-settings-panel');
    const header = document.getElementById('visualizer-settings-header');
    if (!button || !panel || !header) return;

    try {
        const saved = JSON.parse(localStorage.getItem(VISUALIZER_SETTINGS_KEY) || '{}');
        Object.assign(visualizerSettings, saved);
        if (saved.energy === undefined && saved.sensitivity !== undefined) {
            visualizerSettings.energy = Math.round((saved.sensitivity - 70) / 0.9);
        }
    } catch (err) {
        console.warn('Failed to load visualizer settings:', err);
    }

    const enabled = document.getElementById('visualizer-enabled');
    const mode = document.getElementById('visualizer-mode');
    const palette = document.getElementById('visualizer-palette');
    const energy = document.getElementById('visualizer-energy');

    enabled.checked = visualizerSettings.enabled;
    mode.value = visualizerSettings.mode;
    palette.value = visualizerSettings.palette;
    enabled.addEventListener('change', () => {
        visualizerSettings.enabled = enabled.checked;
        saveVisualizerSettings();
    });
    mode.addEventListener('change', () => {
        visualizerSettings.mode = mode.value;
        saveVisualizerSettings();
    });
    palette.addEventListener('change', () => {
        visualizerSettings.palette = palette.value;
        saveVisualizerSettings();
    });

    energy.value = visualizerSettings.energy;
    energy.addEventListener('input', () => {
        visualizerSettings.energy = Number(energy.value);
        document.getElementById('visualizer-energy-value').textContent = energy.value;
        saveVisualizerSettings();
    });

    button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const isOpen = panel.classList.toggle('open');
        panel.style.transform = isOpen ? 'translateX(0)' : 'translateX(100%)';
        button.classList.toggle('active', isOpen);
    });

    let startX = 0;
    let currentX = 0;
    header.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        currentX = startX;
        panel.classList.add('no-transition');
    }, { passive: true });
    header.addEventListener('touchmove', (e) => {
        currentX = e.touches[0].clientX;
        if (panel.classList.contains('open')) {
            panel.style.transform = `translateX(${Math.max(0, currentX - startX)}px)`;
        }
    }, { passive: true });
    header.addEventListener('touchend', () => {
        panel.classList.remove('no-transition');
        if (currentX - startX > 50) {
            panel.classList.remove('open');
            panel.style.transform = 'translateX(100%)';
            button.classList.remove('active');
        } else {
            panel.style.transform = 'translateX(0)';
        }
    });
}

function saveVisualizerSettings() {
    try {
        localStorage.setItem(VISUALIZER_SETTINGS_KEY, JSON.stringify(visualizerSettings));
    } catch (err) {
        console.warn('Failed to save visualizer settings:', err);
    }
}
