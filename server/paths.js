// 資料存放位置。
// 本機開發：就放在專案的 data/ 與 public/images/。
// 雲端部署：設 DATA_DIR / IMAGES_DIR 指到永久儲存空間（Volume），
//           否則主機一重啟，訂單和店家上傳的照片就會被清掉。
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 程式內建的菜色照片，第一次部署時要複製進永久儲存空間 */
const BUNDLED_IMAGES = join(ROOT, 'public', 'images');

export const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
export const IMAGES_DIR = resolve(process.env.IMAGES_DIR || BUNDLED_IMAGES);
export const DB_PATH = join(DATA_DIR, 'restaurant.db');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(IMAGES_DIR, { recursive: true });

// 全新的 Volume 是空的，把內建照片補進去，否則菜單會整排破圖
if (
  IMAGES_DIR !== resolve(BUNDLED_IMAGES) &&
  existsSync(BUNDLED_IMAGES) &&
  readdirSync(IMAGES_DIR).length === 0
) {
  cpSync(BUNDLED_IMAGES, IMAGES_DIR, { recursive: true });
}
