/* -------------------------------------------------------------
   Music Runner v2.0 - Application Logic (Vanilla JS)
   ------------------------------------------------------------- */

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
let bulkRefreshRaf = 0;
let pendingBulkRefreshFolders = null;
let cachedFolderFiles = null; // fallback入力からキャッシュしたファイル群（同一セッションのみ）

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
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');

const btnLoop = document.getElementById('btn-loop');
const btnPlayPause = document.getElementById('btn-play-pause');
const btnBackHome = document.getElementById('btn-back-home');

const fileTreePanel = document.getElementById('file-tree-panel');
const fileTreeContainer = document.getElementById('file-tree-container');

// アイコン表示切り替え用
const iconLoop = btnLoop.querySelector('.icon-loop');
const iconPlay = btnPlayPause.querySelector('.icon-play');
const iconPause = btnPlayPause.querySelector('.icon-pause');

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

    initEventListeners();
    initFileTreeInteraction();
    initSwipeGestures();
// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
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
    });

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
    mainVideo.play().then(() => {
        iconPlay.classList.add('hidden');
        iconPause.classList.remove('hidden');
        document.getElementById('music-placeholder').classList.add('playing');
    }).catch(err => {
        console.error('Play failed:', err);
    });
}

function pauseMedia() {
    mainVideo.pause();
    iconPlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
    document.getElementById('music-placeholder').classList.remove('playing');
}

function updateProgressBar() {
    if (!mainVideo.duration) return;
    progressSlider.value = Math.floor(mainVideo.currentTime);
    timeCurrent.textContent = formatTime(mainVideo.currentTime);
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
            const handle = await window.showDirectoryPicker();
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

        if (playlistQueue.length > 0) {
            playNode(playlistQueue[0]);
        } else if (flatFiles.length > 0) {
            playNode(flatFiles[0]);
        }
        return;
    }

    // IndexedDB に保存したディレクトリハンドルを使用（ページを閉じても復元可能）
    try {
        const lastHandle = await getVal(LAST_DIR_KEY);
        if (lastHandle) {
            const granted = await verifyPermission(lastHandle, false);
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
                const handle = await window.showDirectoryPicker();
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

    // IndexedDB に保存して次回起動時に備える
    await setVal(LAST_DIR_KEY, dirHandle);
    saveLastFolderMeta(dirHandle.name, 'handle');
    cachedFolderFiles = null;
    await updateLastFolderButton();

    // 状態記憶用のキーをフォルダ名から生成
    const stateKey = `musicrunner_state_${dirHandle.name}`;
    const savedState = localStorage.getItem(stateKey);
    if (savedState) {
        currentState = JSON.parse(savedState);
        if (!currentState.openFolders) currentState.openFolders = {};
        if (!currentState.checkedFiles) currentState.checkedFiles = {};
    } else {
        currentState = { openFolders: {}, checkedFiles: {} };
    }

    // フォルダのトラバース
    rootItems = await traverseDirectory(dirHandle);
    flatFiles = flattenTreeFiles(rootItems);

    // プレイリストキューの作成 (チェックボックスの状態を考慮)
    updatePlaylistQueue();

    // UIレンダリング
    renderFileTree(rootItems);

    showScreen('play');

    // キューに曲があれば最初の曲を再生する
    if (playlistQueue.length > 0) {
        playNode(playlistQueue[0]);
    } else if (flatFiles.length > 0) {
        // 全てチェックが外れている場合はフラット配列の最初を再生
        playNode(flatFiles[0]);
    } else {
        alert('再生可能なメディアファイルが見つかりません。');
    }
}

// 再帰的にディレクトリをトラバース
async function traverseDirectory(dirHandle, relativePath = '') {
    const items = [];
    for await (const entry of dirHandle.values()) {
        const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.kind === 'file') {
            if (isMediaFile(entry.name)) {
                const fileNode = {
                    kind: 'file',
                    name: entry.name,
                    path: entryPath,
                    handle: entry
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
                    children: subItems
                });
            }
        }
    }
    // フォルダー → ファイルの順で、それぞれa-z
    items.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return items;
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
        // デフォルトではチェックボックスはオン(true)とする
        return isChecked !== false;
    });
}

// 状態の保存（FSA / フォールバック共通）
function saveCurrentState() {
    const folderName = activeFolderName || directoryHandle?.name;
    if (!folderName) return;
    const stateKey = `musicrunner_state_${folderName}`;
    localStorage.setItem(stateKey, JSON.stringify(currentState));
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

function initFileTreeInteraction() {
    if (fileTreeContainer.dataset.interactionBound) return;
    fileTreeContainer.dataset.interactionBound = '1';

    fileTreeContainer.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.checkbox-container')) return;

        const row = e.target.closest('.tree-row');
        if (!row || row.dataset.rootBulk) return;

        if (row.classList.contains('folder-row')) {
            e.preventDefault();
            toggleFolderRow(row);
        }
    }, { passive: false });

    fileTreeContainer.addEventListener('pointerup', (e) => {
        if (e.target.closest('.checkbox-container')) return;

        const row = e.target.closest('.file-row');
        if (!row) return;

        const node = fileByPath.get(row.dataset.path);
        if (node) {
            playNode(node);
            closeFileTreePanel();
        }
    });
}

// --- チェックボックス一括操作（直下のファイルのみ） ---
function isFilePathChecked(path) {
    return currentState.checkedFiles[path] !== false;
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
        e.preventDefault();
        e.stopPropagation();
    };
    input.addEventListener('click', stopEvent);
    input.addEventListener('change', stopEvent);
    cbContainer.addEventListener('click', stopEvent, true);

    // 1回のタップで1回だけトグル（連打可・二重発火なし）
    let activePointerId = null;
    cbContainer.addEventListener('pointerdown', (e) => {
        stopEvent(e);
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (activePointerId !== null) return;
        activePointerId = e.pointerId;
        try {
            cbContainer.setPointerCapture(e.pointerId);
        } catch { /* ignore */ }
        toggleCheckboxInput(input, (newChecked) => {
            syncCheckboxAria(cbContainer, input);
            onToggle(newChecked);
        });
    }, { passive: false });

    const releasePointer = (e) => {
        if (e.pointerId !== activePointerId) return;
        activePointerId = null;
        try {
            if (cbContainer.hasPointerCapture(e.pointerId)) {
                cbContainer.releasePointerCapture(e.pointerId);
            }
        } catch { /* ignore */ }
    };
    cbContainer.addEventListener('pointerup', releasePointer);
    cbContainer.addEventListener('pointercancel', releasePointer);

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
async function playNode(node) {
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

        playMedia();
    } catch (err) {
        console.error('Play node error:', err);
    }
}

// 再生終了時のロジック
function handlePlaybackEnded() {
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

        // 現在の曲のインデックスを取得
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

function handleFallbackFolder(e) {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    isFolderLoaded = true;

    // Determine top-level folder name
    let folderName = 'Local Folder';
    if (files[0].webkitRelativePath) {
        folderName = files[0].webkitRelativePath.split('/')[0];
    }

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

    if (playlistQueue.length > 0) {
        playNode(playlistQueue[0]);
    } else if (flatFiles.length > 0) {
        playNode(flatFiles[0]);
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

    // 3. パネル本体（リスト）をスクロール最上部でスワイプアップしても閉じる
    panelBody.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
        panelHeight = fileTreePanel.offsetHeight;
    }, { passive: true });

    panelBody.addEventListener('touchmove', (e) => {
        touchCurrentY = e.touches[0].clientY;
        const diff = touchCurrentY - touchStartY;
        // スクロールが一番上にある場合のみパネルを引き上げるアニメーション
        if (fileTreePanel.classList.contains('open') && panelBody.scrollTop === 0 && diff < -10) {
            isDragging = true;
            fileTreePanel.classList.add('no-transition');
            const ty = Math.min(0, diff);
            fileTreePanel.style.transform = `translateY(${ty}px)`;
        }
    }, { passive: true });

    panelBody.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        fileTreePanel.classList.remove('no-transition');
        const diff = touchCurrentY - touchStartY;
        if (diff < -50) {
            closeFileTreePanel();
        } else {
            openFileTreePanel();
        }
    });
}

function openFileTreePanel() {
    fileTreePanel.classList.add('open');
    fileTreePanel.style.transform = 'translateY(0)';
}

function closeFileTreePanel() {
    fileTreePanel.classList.remove('open');
    fileTreePanel.style.transform = 'translateY(-100%)';
}
