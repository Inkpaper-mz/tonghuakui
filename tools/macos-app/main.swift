/* ═══════════════════════════════════════════════════════════════
   同花亏 TongHuaKui · macOS 原生外壳
   ─ 用系统 WKWebView 开窗口（不依赖 Chrome / Electron）
   ─ 内嵌 Node 启动 server/server.js，就绪后自动载入界面
   ─ 退出时回收子进程；若 8899 已有实例则直接接入（多开不冲突）
   编译：见 tools/build-macos-app.sh
   ═══════════════════════════════════════════════════════════════ */

import Cocoa
import WebKit

let APP_PORT = 8899
let APP_TITLE = "同花亏 — 商业模拟对战平台"
let APP_VERSION = "1.0.0"

/* ───────── 路径工具 ───────── */

func resourceDir() -> URL {
    return Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
}

func bundledAppDir() -> URL {
    return resourceDir().appendingPathComponent("app", isDirectory: true)
}

func supportDir() -> URL {
    let base = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/TongHuaKui", isDirectory: true)
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base
}

func logFileURL() -> URL {
    let base = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/TongHuaKui", isDirectory: true)
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base.appendingPathComponent("server.log")
}

/* ═══════════════ 应用代理 ═══════════════ */

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {

    var window: NSWindow!
    var webView: WKWebView!

    var overlay: NSView!
    var spinner: NSProgressIndicator!
    var statusLabel: NSTextField!
    var detailLabel: NSTextField!
    var retryButton: NSButton!

    var serverProcess: Process?
    var pollTimer: Timer?
    var waitedTicks = 0
    var attachedToExisting = false
    var logHandle: FileHandle?
    var loaded = false
    var bridge: Bridge?
    var logBridge: LogBridge?

    /* ───────── 生命周期 ───────── */

    func applicationDidFinishLaunching(_ notification: Notification) {
        openLogHandle()
        appendClientLog("[app] 启动 \(APP_VERSION)（\(ProcessInfo.processInfo.operatingSystemVersionString)）")
        buildMenu()
        buildWindow()
        NSApp.activate(ignoringOtherApps: true)
        begin()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { return true }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { return true }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
        stopServer()
    }

    /* ───────── 菜单 ───────── */

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 同花亏", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "打开数据目录", action: #selector(openDataDir), keyEquivalent: "")
        appMenu.addItem(withTitle: "打开日志", action: #selector(openLog), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 同花亏", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 同花亏", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示")
        viewMenu.addItem(withTitle: "重新载入", action: #selector(reloadPage), keyEquivalent: "r")
        let restart = viewMenu.addItem(withTitle: "重新启动服务端", action: #selector(restartServer), keyEquivalent: "R")
        restart.keyEquivalentModifierMask = [.command, .shift]
        viewMenu.addItem(.separator())
        let dev = viewMenu.addItem(withTitle: "开发者工具", action: #selector(toggleDevTools), keyEquivalent: "i")
        dev.keyEquivalentModifierMask = [.command, .option]
        viewMenu.addItem(.separator())
        let snap = viewMenu.addItem(withTitle: "保存界面截图…", action: #selector(saveSnapshot), keyEquivalent: "s")
        snap.keyEquivalentModifierMask = [.command, .shift]
        viewMenu.addItem(.separator())
        let full = viewMenu.addItem(withTitle: "进入全屏幕", action: #selector(toggleFullScreen), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(withTitle: "放大", action: #selector(zoomIn), keyEquivalent: "+")
        viewMenu.addItem(withTitle: "缩小", action: #selector(zoomOut), keyEquivalent: "-")
        viewMenu.addItem(withTitle: "实际大小", action: #selector(zoomReset), keyEquivalent: "0")
        viewItem.submenu = viewMenu

        let winItem = NSMenuItem()
        main.addItem(winItem)
        let winMenu = NSMenu(title: "窗口")
        winMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = winMenu
        NSApp.windowsMenu = winMenu

        NSApp.mainMenu = main
    }

    /* ───────── 窗口 ───────── */

    func buildWindow() {
        /* 默认窗口刻意比屏幕小一圈（不铺满、不挡用户其它窗口）：
           首次启动 1280×800 居中偏上；用户自己拖动/缩放后会被记住。 */
        let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = min(1280.0, max(1000.0, vis.width - 200))
        let h = min(800.0, max(660.0, vis.height - 200))
        let rect = NSRect(x: vis.minX + (vis.width - w) / 2,
                          y: vis.minY + vis.height - h - 60,
                          width: w, height: h)

        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered,
                          defer: false)
        window.title = APP_TITLE
        window.minSize = NSSize(width: 1000, height: 660)
        /* 有历史尺寸就用历史，否则用上面算好的小窗；
           同时夹紧历史里可能存下的"铺满屏幕"尺寸（旧版本留下的） */
        let restored = window.setFrameAutosaveName("TongHuaKuiMainWindowV3")
        if restored {
            var f = window.frame
            let maxW = vis.width - 120, maxH = vis.height - 120
            if f.width > maxW || f.height > maxH || f.minX < vis.minX || f.minY < vis.minY {
                f.size = NSSize(width: min(f.width, maxW), height: min(f.height, maxH))
                f.origin = NSPoint(x: max(f.minX, vis.minX + 40), y: max(f.minY, vis.minY + 40))
                window.setFrame(f, display: false)
            }
        } else {
            window.setContentSize(NSSize(width: w, height: h))
            window.setFrameOrigin(NSPoint(x: rect.minX, y: rect.minY))
        }
        /* 网页铺满整个窗口（含标题栏区域），红绿灯浮在网页顶栏之上：
           网页左侧预留 84px 给红绿灯（见 client/css/app.css 的 body.app-mac 规则），
           拖动窗口由网页顶栏通过 JS↔原生桥实现（见 handleBridge 的 drag）。 */
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.backgroundColor = NSColor(calibratedRed: 0.07, green: 0.10, blue: 0.16, alpha: 1.0)

        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        cfg.websiteDataStore = .default()
        let b = Bridge()
        b.app = self
        cfg.userContentController.add(b, name: "ths")
        bridge = b

        /* 把网页 console.* 转发到应用日志，便于真机排查 UI 问题 */
        let lb = LogBridge()
        lb.app = self
        cfg.userContentController.add(lb, name: "thsLog")
        logBridge = lb
        let hook = """
        (function(){
          function send(level, args){
            try {
              var s = Array.prototype.map.call(args, function(a){
                try { return (a && typeof a === 'object') ? JSON.stringify(a) : String(a); }
                catch(e){ return String(a); }
              }).join(' ');
              window.webkit.messageHandlers.thsLog.postMessage(level + ' ' + s);
            } catch(e){}
          }
          ['log','warn','error','info'].forEach(function(k){
            var orig = console[k] ? console[k].bind(console) : function(){};
            console[k] = function(){ send(k.toUpperCase(), arguments); try { orig.apply(null, arguments); } catch(e){} };
          });
        })();
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: hook, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        /* 用「容器 + Auto Layout」装配：webView 永远精确等于内容区，
           不再手算 frame，避免窗口缩放/标题栏差异导致网页视图高度不对。 */
        let container = NSView(frame: window.contentView?.bounds ?? rect)
        container.autoresizingMask = [.width, .height]
        window.contentView = container

        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.allowsMagnification = true
        webView.setValue(false, forKey: "drawsBackground")
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        buildOverlay(container, rect)

        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
    }

    func buildOverlay(_ container: NSView, _ rect: NSRect) {
        let w = rect.width, h = rect.height
        overlay = NSView(frame: container.bounds)
        overlay.autoresizingMask = [.width, .height]
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor(calibratedRed: 0.05, green: 0.07, blue: 0.10, alpha: 1.0).cgColor

        let cx = w / 2

        spinner = NSProgressIndicator(frame: NSRect(x: cx - 16, y: h / 2 + 54, width: 32, height: 32))
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.isIndeterminate = true
        spinner.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        spinner.startAnimation(nil)
        overlay.addSubview(spinner)

        statusLabel = NSTextField(labelWithString: "正在启动 同花亏 …")
        statusLabel.font = NSFont.boldSystemFont(ofSize: 20)
        statusLabel.textColor = NSColor.white
        statusLabel.alignment = .center
        statusLabel.frame = NSRect(x: cx - 280, y: h / 2 + 8, width: 560, height: 30)
        statusLabel.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        overlay.addSubview(statusLabel)

        detailLabel = NSTextField(labelWithString: "首次启动会拉起本地行情服务端，请稍候…")
        detailLabel.font = NSFont.systemFont(ofSize: 13)
        detailLabel.textColor = NSColor(calibratedWhite: 0.72, alpha: 1.0)
        detailLabel.alignment = .center
        detailLabel.lineBreakMode = .byWordWrapping
        detailLabel.maximumNumberOfLines = 6
        detailLabel.frame = NSRect(x: cx - 320, y: h / 2 - 96, width: 640, height: 96)
        detailLabel.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        overlay.addSubview(detailLabel)

        retryButton = NSButton(frame: NSRect(x: cx - 60, y: h / 2 - 140, width: 120, height: 30))
        retryButton.title = "重试"
        retryButton.bezelStyle = .rounded
        retryButton.target = self
        retryButton.action = #selector(retryTapped)
        retryButton.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        retryButton.isHidden = true
        overlay.addSubview(retryButton)

        container.addSubview(overlay)
    }

    /* ───────── 启动流程 ───────── */

    func begin() {
        loaded = false
        retryButton?.isHidden = true
        spinner?.startAnimation(nil)
        statusLabel?.stringValue = "正在启动 同花亏 …"
        detailLabel?.textColor = NSColor(calibratedWhite: 0.72, alpha: 1.0)
        detailLabel?.stringValue = "首次启动会拉起本地行情服务端，请稍候…"

        pingServer { [weak self] alive in
            guard let self = self else { return }
            if alive {
                self.attachedToExisting = true
                self.setStatus("已连接到正在运行的服务端")
                self.loadApp()
            } else {
                self.startServer()
            }
        }
    }

    func startServer() {
        let candidates = nodeCandidates()
        guard !candidates.isEmpty else {
            showFatal("找不到 Node.js 运行时",
                      detail: "本机既没有可用的内嵌 node，也没有安装 Node.js。\n请到 https://nodejs.org 安装 Node 20 LTS 后重试。")
            return
        }
        let appDir = bundledAppDir()
        let serverJS = appDir.appendingPathComponent("server/server.js").path
        guard FileManager.default.fileExists(atPath: serverJS) else {
            showFatal("应用资源不完整",
                      detail: "找不到 \(serverJS)\n请重新执行 tools/build-macos-app.sh 构建。")
            return
        }

        let proc = Process()
        proc.arguments = [serverJS, "--port", String(APP_PORT), "--host", "127.0.0.1"]
        proc.currentDirectoryURL = appDir
        var env = ProcessInfo.processInfo.environment
        env["THK_PORT"] = String(APP_PORT)
        env["THK_HOST"] = "127.0.0.1"
        env["THK_DATA"] = supportDir().appendingPathComponent("store.json").path
        proc.environment = env

        let lf = logFileURL()
        openLogHandle()
        if let fh = logHandle {
            proc.standardOutput = fh
            proc.standardError = fh
        }

        proc.terminationHandler = { [weak self] p in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if self.loaded || self.attachedToExisting { return }
                self.showFatal("服务端进程意外退出（退出码 \(p.terminationStatus)）",
                              detail: "日志文件：\(lf.path)")
            }
        }

        var launched = false
        var lastError = ""
        for node in candidates {
            proc.executableURL = URL(fileURLWithPath: node)
            do { try proc.run(); launched = true; break }
            catch { lastError = "\(node)\n  → \(error.localizedDescription)" }
        }
        guard launched else {
            showFatal("无法启动服务端",
                      detail: (lastError.isEmpty ? "所有候选 Node 都无法执行。" : lastError) +
                              "\n\n已尝试：\n" + candidates.joined(separator: "\n"))
            return
        }
        serverProcess = proc
        setStatus("正在启动本地行情服务端…")
        startPolling()
    }

    func startPolling() {
        waitedTicks = 0
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] timer in
            guard let self = self else { timer.invalidate(); return }
            self.waitedTicks += 1
            self.pingServer { alive in
                if alive {
                    timer.invalidate()
                    self.setStatus("服务端就绪，正在载入界面…")
                    self.loadApp()
                } else if self.waitedTicks > 100 {
                    timer.invalidate()
                    self.showFatal("服务端启动超时",
                                  detail: "等待超过 30 秒仍未就绪。\n日志文件：\(logFileURL().path)")
                } else if self.waitedTicks % 7 == 0 {
                    self.detailLabel?.stringValue = "服务端启动中… 已等待 \(Int(Double(self.waitedTicks) * 0.3)) 秒"
                }
            }
        }
    }

    func pingServer(_ done: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(APP_PORT)/index.html") else { done(false); return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.0
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func loadApp() {
        /* real=1：桌面版默认连"本机真实服务端"，而不是前端内置的演示数据 */
        guard let url = URL(string: "http://127.0.0.1:\(APP_PORT)/index.html?real=1") else { return }
        webView.load(URLRequest(url: url))
    }

    func hideOverlay() {
        guard overlay.superview != nil else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.28
            self.overlay.animator().alphaValue = 0.0
        }, completionHandler: {
            self.overlay.removeFromSuperview()
        })
    }

    func stopServer() {
        guard !attachedToExisting else { return }
        if let p = serverProcess, p.isRunning { p.terminate() }
        serverProcess = nil
    }

    /* ───────── Node 探测 ───────── */

    func nodeCandidates() -> [String] {
        let fm = FileManager.default
        var out: [String] = []

        let bundled = resourceDir().appendingPathComponent("node").path
        if fm.isExecutableFile(atPath: bundled) { out.append(bundled) }

        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/opt/local/bin/node"] {
            if fm.isExecutableFile(atPath: p) { out.append(p) }
        }

        let nvm = fm.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node").path
        if let vers = try? fm.contentsOfDirectory(atPath: nvm) {
            for v in vers.sorted().reversed() {
                let p = "\(nvm)/\(v)/bin/node"
                if fm.isExecutableFile(atPath: p) { out.append(p) }
            }
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/sh")
        proc.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        if (try? proc.run()) != nil {
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !s.isEmpty, fm.isExecutableFile(atPath: s), !out.contains(s) {
                out.append(s)
            }
        }
        return out
    }

    /* ───────── 提示与状态 ───────── */

    func setStatus(_ text: String) {
        statusLabel?.stringValue = text
    }

    func showFatal(_ title: String, detail: String) {
        spinner?.stopAnimation(nil)
        spinner?.isHidden = true
        statusLabel?.stringValue = title
        statusLabel?.textColor = NSColor(calibratedRed: 1.0, green: 0.42, blue: 0.45, alpha: 1.0)
        detailLabel?.stringValue = detail
        retryButton?.isHidden = false
    }

    /* ───────── 动作 ───────── */

    @objc func retryTapped() {
        spinner?.isHidden = false
        statusLabel?.textColor = NSColor.white
        stopServer()
        begin()
    }

    @objc func reloadPage() { webView.reload() }

    @objc func restartServer() {
        stopServer()
        attachedToExisting = false
        loaded = false
        webView.superview?.addSubview(overlay)
        overlay.alphaValue = 1.0
        retryTapped()
    }

    @objc func toggleDevTools() {
        if #available(macOS 13.3, *) {
            if webView.isInspectable { webView.isInspectable = false } else { webView.isInspectable = true }
        }
        let js = "window.__THS_DEVTOOLS__=true;"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    @objc func toggleFullScreen() { window.toggleFullScreen(nil) }
    @objc func zoomIn() { webView.pageZoom = min(3.0, webView.pageZoom + 0.1) }
    @objc func zoomOut() { webView.pageZoom = max(0.5, webView.pageZoom - 0.1) }
    @objc func zoomReset() { webView.pageZoom = 1.0 }

    /** 直接把 WKWebView 的渲染结果存成 PNG（排查 UI 问题/晒图用，不受截图权限影响） */
    @objc func saveSnapshot() {
        let cfg = WKSnapshotConfiguration()
        webView.takeSnapshot(with: cfg) { [weak self] image, error in
            guard let image = image,
                  let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                self?.toast("截图失败：\(error?.localizedDescription ?? "未知错误")")
                return
            }
            let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop")
            let url = dir.appendingPathComponent("同花亏-界面截图.png")
            do {
                try png.write(to: url)
                self?.toast("已保存到桌面：同花亏-界面截图.png")
            } catch {
                self?.toast("保存失败：\(error.localizedDescription)")
            }
        }
    }

    /** 应用内轻提示（用系统通知） */
    func toast(_ text: String) {
        appendClientLog("[app] " + text)
        let n = NSUserNotification()
        n.title = APP_TITLE
        n.informativeText = text
        NSUserNotificationCenter.default.deliver(n)
    }

    @objc func openDataDir() { NSWorkspace.shared.open(supportDir()) }
    @objc func openLog() { NSWorkspace.shared.open(logFileURL()) }

    /** 打开（或复用）应用日志文件句柄：网页 console 与内嵌服务端都写这里 */
    func openLogHandle() {
        if logHandle != nil { return }
        let lf = logFileURL()
        if !FileManager.default.fileExists(atPath: lf.path) {
            FileManager.default.createFile(atPath: lf.path, contents: nil)
        }
        if let fh = try? FileHandle(forWritingTo: lf) {
            fh.seekToEndOfFile()
            logHandle = fh
        }
    }

    /** 网页 console → 应用日志 */
    func appendClientLog(_ text: String) {
        guard let fh = logHandle else { return }
        let line = "[web] \(text)\n"
        if let d = line.data(using: .utf8) { fh.write(d) }
    }

    /* 网页里的假窗口按钮（─ □ ✕ / 顶栏拖动）在 .app 内控制真实窗口 */
    func handleBridge(_ body: [String: Any]) {
        let action = (body["action"] as? String) ?? ""
        switch action {
        case "drag":
            /* 网页顶栏拖动 → 移动真窗口（屏幕坐标 Y 向下，Cocoa Y 向上，故取负） */
            let dx = (body["dx"] as? NSNumber)?.doubleValue ?? 0
            let dy = (body["dy"] as? NSNumber)?.doubleValue ?? 0
            var o = window.frame.origin
            o.x += CGFloat(dx)
            o.y -= CGFloat(dy)
            window.setFrameOrigin(o)
        case "minimize": window.miniaturize(nil)
        case "maximize": window.zoom(nil)   // NSWindow.zoom 本身就是切换
        case "fullscreen": window.toggleFullScreen(nil)
        case "reload": reloadPage()
        case "close": NSApp.terminate(nil)
        default: break
        }
    }

    @objc func showAbout() {
        let a = NSAlert()
        a.messageText = "同花亏 TongHuaKui \(APP_VERSION)"
        a.informativeText = """
        同样的行情，不同的亏损。

        一个模仿 Windows 完全版同花顺界面的
        多人联网股票交易商业模拟对战游戏。

        服务端：内嵌 Node.js（零 npm 依赖）
        客户端：本机 http://127.0.0.1:\(APP_PORT)
        数据目录：~/Library/Application Support/TongHuaKui

        本游戏所有股票代码、名称、行情、新闻均为虚构，
        与真实市场无关，不构成任何投资建议。
        """
        a.addButton(withTitle: "知道了")
        a.runModal()
    }

    /* ───────── WKNavigationDelegate ───────── */

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !loaded {
            loaded = true
            hideOverlay()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if !loaded { showFatal("界面载入失败", detail: error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if !loaded { showFatal("界面载入失败", detail: error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let host = url.host,
           host != "127.0.0.1" && host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

/* ═══════════════ 网页 console → 应用日志 ═══════════════ */

final class LogBridge: NSObject, WKScriptMessageHandler {
    weak var app: AppDelegate?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        app?.appendClientLog(String(describing: message.body))
    }
}

/* ═══════════════ 网页 ↔ 原生 桥 ═══════════════ */

final class Bridge: NSObject, WKScriptMessageHandler {
    weak var app: AppDelegate?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        app?.handleBridge(body)
    }
}

/* ═══════════════ 入口 ═══════════════ */

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
