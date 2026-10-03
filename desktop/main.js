const { app, BrowserWindow, shell, session, Menu } = require('electron');
const path = require('path'), fs = require('fs');

let URL_ = 'https://YOURDOMAIN.com';
try { URL_ = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).url; } catch {}
const origin = new URL(URL_).origin;

if (!app.requestSingleInstanceLock()) app.quit();
let win;
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function create() {
  win = new BrowserWindow({
    width: 1000, height: 720, minWidth: 380, minHeight: 500, title: 'پیام‌رسان', backgroundColor: '#f2f6fc',
    autoHideMenuBar: true, icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'viewMenu' }]));
  const load = () => win && win.loadURL(URL_);
  // سرور رایگان ممکن است خواب باشد؛ صفحه‌ی انتظار نشان بده و هر ۵ ثانیه دوباره امتحان کن
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3 || url.startsWith('file:')) return;
    win.loadFile(path.join(__dirname, 'offline.html')); setTimeout(load, 5000);
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && new URL(url).origin !== origin) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
  load();
}

app.whenReady().then(() => {
  // میکروفون (ویس) و اعلان فقط برای خود سرور پیام‌رسان مجاز است
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    let ok = false; try { ok = ['media', 'notifications'].includes(perm) && new URL(details.requestingUrl).origin === origin; } catch {}
    cb(ok);
  });
  create();
});
app.on('window-all-closed', () => app.quit());
