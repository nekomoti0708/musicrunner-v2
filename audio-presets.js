/**
 * オーディオエフェクトのプリセット（テンプレート）を管理するファイルです。
 * ここに新しいプリセットを追加すると、自動的に画面のドロップダウンメニューに反映されます。
 */

window.audioPresets = [
    { 
        id: 'normal', 
        name: 'Normal (通常)', 
        bass: 0, 
        treble: 0, 
        dist: 0, 
        rev: 0 
    },
    { 
        id: 'live', 
        name: 'Live Concert (ライブ会場)', 
        bass: 4, 
        treble: 2, 
        dist: 5, 
        rev: 60 
    },
    { 
        id: 'radio', 
        name: 'Radio (古いラジオ)', 
        bass: -15, 
        treble: -10, 
        dist: 40, 
        rev: 0 
    },
    { 
        id: 'club', 
        name: 'Club (クラブ・重低音)', 
        bass: 12, 
        treble: 4, 
        dist: 10, 
        rev: 15 
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
