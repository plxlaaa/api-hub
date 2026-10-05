#!/usr/bin/env python3
"""为文档生成界面截图（登录页 + 各标签页 + 模型广场 + 暗色模式）。

前置条件：
  1. 本地已启动服务（默认 http://127.0.0.1:3000）
  2. 已完成管理员初始化（能正常登录）
  3. pip install playwright && playwright install chromium

用法：
  python3 tools/shoot.py [base-url] [输出目录] [用户名] [密码]

产物直接覆盖 docs/screenshots/ 下的同名文件，README / INSTALL / docs/API 的
<img> 引用无需改动。截图会缩到 1600px 宽并量化到 256 色，单张约 40KB。
"""
import glob
import os
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000"
OUT = sys.argv[2] if len(sys.argv) > 2 else "docs/screenshots"
USER = sys.argv[3] if len(sys.argv) > 3 else "demo"
PASS = sys.argv[4] if len(sys.argv) > 4 else "demo123456"

# 2x 设备像素比截全分辨率，再缩到 1600 宽：文档里清晰，仓库体积可控
VIEWPORT = {"width": 1440, "height": 900}
FINAL_WIDTH = 1600
QUANT_COLORS = 256

# (导航文字, 输出文件名)
TABS = [
    ("渠道管理", "03-channels.png"),
    ("模型路由", "04-routes.png"),
    ("API 密钥", "05-tokens.png"),
    ("调用日志", "06-request-logs.png"),
    ("调用示例", "07-usage.png"),
]


def settle(page, ms=1200):
    """等待网络与动画稳定，避免截到骨架屏/半渲染状态。"""
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    page.wait_for_timeout(ms)


def shoot(page, name):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    page.screenshot(path=path)
    print("saved", path)


def shoot_login_page(page):
    """登录页：已登录时先登出再截。"""
    page.goto(BASE, wait_until="domcontentloaded")
    settle(page)
    if page.locator('input[autocomplete="username"]').count() == 0:
        page.evaluate("fetch('/api/auth/logout',{method:'POST'})")
        page.reload(wait_until="domcontentloaded")
        settle(page)
    shoot(page, "01-login.png")


def login(page):
    page.goto(BASE, wait_until="domcontentloaded")
    settle(page)
    if page.locator('input[autocomplete="username"]').count() == 0:
        print("already logged in")
        return
    page.fill('input[autocomplete="username"]', USER)
    page.fill('input[autocomplete="current-password"]', PASS)
    page.get_by_role("button", name="登录").click()
    page.wait_for_selector('nav[aria-label="主导航"]', timeout=20000)
    settle(page, 2000)


def open_tab(page, label):
    page.locator('nav[aria-label="主导航"] button', has_text=label).first.click()
    settle(page, 1800)


def capture(page):
    shoot_login_page(page)

    login(page)
    shoot(page, "02-dashboard.png")

    for label, name in TABS:
        open_tab(page, label)
        shoot(page, name)

    # 模型广场是独立路由
    page.goto(BASE + "/square", wait_until="domcontentloaded")
    settle(page, 2500)
    shoot(page, "08-square.png")

    # 暗色模式：走真实的主题切换按钮（next-themes 写 localStorage）
    page.goto(BASE, wait_until="domcontentloaded")
    settle(page)
    toggle = page.locator('button[aria-label="切换到暗色模式"]')
    if toggle.count() > 0:
        toggle.first.click()
        settle(page, 1500)
    shoot(page, "09-dashboard-dark.png")


def optimize():
    """缩宽 + 量化，把 9 张图从 ~2.3MB 压到 ~350KB，肉眼无差。"""
    total = 0
    for path in sorted(glob.glob(os.path.join(OUT, "*.png"))):
        before = os.path.getsize(path)
        im = Image.open(path).convert("RGB")
        w, h = im.size
        nw = min(FINAL_WIDTH, w)
        if nw < w:
            im = im.resize((nw, round(h * nw / w)), Image.LANCZOS)
        im.quantize(colors=QUANT_COLORS, method=Image.FASTOCTREE, dither=Image.Dither.NONE).save(
            path, optimize=True
        )
        after = os.path.getsize(path)
        total += after
        print(f"  {os.path.basename(path)}: {before // 1024}KB -> {after // 1024}KB")
    print(f"总计 {total // 1024}KB")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"]
        )
        ctx = browser.new_context(
            viewport=VIEWPORT, device_scale_factor=2, locale="zh-CN", color_scheme="light"
        )
        page = ctx.new_page()
        capture(page)
        browser.close()

    print("优化体积…")
    optimize()
    print("done ->", OUT)


if __name__ == "__main__":
    main()
