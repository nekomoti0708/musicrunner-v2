/**
 * オーディオエフェクトのプリセット（テンプレート）を管理するファイルです。
 * ここに新しいプリセットを追加すると、自動的に画面のドロップダウンメニューに反映されます。
 */

window.audioPresets = [
    {
        id: 'normal',
        name: 'normal',
        bass: 0,
        treble: 0,
        dist: 0,
        rev: 0
    },
    {
        id: 'live',
        name: 'live',
        bass: -5,
        treble: -2,
        dist: 4,
        rev: 50
    },
    {
        id: 'radio',
        name: 'radio',
        bass: -12,
        treble: -18,
        dist: 20,
        rev: 0
    },
    {
        id: 'club',
        name: 'club',
        bass: 2,
        treble: -20,
        dist: 1,
        rev: 2
    },

    // ==========================================
    // ▼ ここから下に自分オリジナルのプリセットを追加できます ▼
    // ==========================================

    // 例: ボーカル強調
    /*
    {
        id: 'vocal_boost',
        name: 'Vocal Boost (ボーカル強調)',
        bass: -2,      // 低音 (-20 〜 20)
        treble: 6,     // 高音 (-20 〜 20)
        dist: 0,       // 歪み (0 〜 100)
        rev: 5         // 残響 (0 〜 100)
    },
    */
];
