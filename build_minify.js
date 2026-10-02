// build_minify.js - JS/CSS/HTMLを圧縮(minify)し、非圧縮静的ファイルと共に.dist_buildへ出力するスクリプト
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = __dirname;
const OUT_DIR = path.join(PROJECT_ROOT, '.dist_build');

// ディレクトリ削除
function cleanDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ディレクトリ再帰コピー
function copyDir(src, dest) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// HTML の圧縮 (コメント削除、余分な空白・インデント削除)
function minifyHtml(html) {
    return html
        .replace(/<!--(?!\[if)[\s\S]*?-->/g, '') // コメント削除
        .replace(/>\s+</g, '><')                // タグ間の空白・改行削除
        .trim();
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

async function main() {
    console.log('==================================================');
    console.log(' 🚀 圧縮ビルド (Minify & Bundle) を開始します...');
    console.log('==================================================');

    // esbuild モジュールのロード試行
    let esbuild = null;
    try {
        esbuild = require('esbuild');
    } catch {
        console.warn('ℹ esbuild モジュールがローカルに見つかりません。npx経由またはコピーでフォールバックします。');
    }

    // 1. 出力フォルダ準備
    cleanDir(OUT_DIR);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const stats = [];

    // 2. JS / CSS の圧縮
    const codeFiles = [
        { file: 'main.js', loader: 'js' },
        { file: 'audio-presets.js', loader: 'js' },
        { file: 'sw.js', loader: 'js' },
        { file: 'style.css', loader: 'css' }
    ].filter(item => fs.existsSync(path.join(PROJECT_ROOT, item.file)));

    for (const item of codeFiles) {
        const srcFile = path.join(PROJECT_ROOT, item.file);
        const destFile = path.join(OUT_DIR, item.file);
        const originalContent = fs.readFileSync(srcFile, 'utf8');
        const originalSize = Buffer.byteLength(originalContent, 'utf8');

        let minifiedContent = originalContent;
        if (esbuild) {
            try {
                const res = await esbuild.transform(originalContent, {
                    loader: item.loader,
                    minify: true,
                    legalComments: 'none'
                });
                minifiedContent = res.code;
            } catch (e) {
                console.warn(`[圧縮エラー: ${item.file}]`, e.message);
            }
        }

        fs.writeFileSync(destFile, minifiedContent, 'utf8');
        const minifiedSize = Buffer.byteLength(minifiedContent, 'utf8');
        const reduction = originalSize > 0 ? (((originalSize - minifiedSize) / originalSize) * 100).toFixed(1) : 0;
        stats.push({ file: item.file, originalSize, minifiedSize, reduction: `${reduction}% 削減` });
    }

    // 3. HTML の圧縮
    const htmlFile = 'index.html';
    if (fs.existsSync(path.join(PROJECT_ROOT, htmlFile))) {
        const srcFile = path.join(PROJECT_ROOT, htmlFile);
        const destFile = path.join(OUT_DIR, htmlFile);
        const rawHtml = fs.readFileSync(srcFile, 'utf8');
        const originalSize = Buffer.byteLength(rawHtml, 'utf8');

        const minifiedHtml = minifyHtml(rawHtml);
        fs.writeFileSync(destFile, minifiedHtml, 'utf8');
        const minifiedSize = Buffer.byteLength(minifiedHtml, 'utf8');
        const reduction = originalSize > 0 ? (((originalSize - minifiedSize) / originalSize) * 100).toFixed(1) : 0;
        stats.push({ file: htmlFile, originalSize, minifiedSize, reduction: `${reduction}% 削減` });
    }

    // 4. 静的ファイル・未圧縮ファイルのコピー（画像、マニフェスト、音声フォルダなど）
    const copyList = ['manifest.json', 'icons', 'test_audio', 'README.md'];
    for (const item of copyList) {
        const srcPath = path.join(PROJECT_ROOT, item);
        const destPath = path.join(OUT_DIR, item);
        if (fs.existsSync(srcPath)) {
            const stat = fs.statSync(srcPath);
            if (stat.isDirectory()) {
                copyDir(srcPath, destPath);
                stats.push({ file: `${item}/ (フォルダ)`, originalSize: '-', minifiedSize: 'そのまま保持', reduction: '非圧縮コピー' });
            } else {
                fs.copyFileSync(srcPath, destPath);
                stats.push({ file: item, originalSize: formatBytes(stat.size), minifiedSize: formatBytes(stat.size), reduction: '非圧縮コピー' });
            }
        }
    }

    // GitHub Pages用の .nojekyll ファイル
    fs.writeFileSync(path.join(OUT_DIR, '.nojekyll'), '', 'utf8');

    // 結果表示
    console.log('\n【ファイル圧縮・コピー結果】');
    console.table(stats.map(s => ({
        'ファイル名': s.file,
        '元サイズ': typeof s.originalSize === 'number' ? formatBytes(s.originalSize) : s.originalSize,
        '圧縮後': typeof s.minifiedSize === 'number' ? formatBytes(s.minifiedSize) : s.minifiedSize,
        '効果': s.reduction
    })));

    console.log('✔ 圧縮ビルドが正常に完了しました (.dist_build)\n');
}

main().catch(err => {
    console.error('ビルドエラー:', err);
    process.exit(1);
});
