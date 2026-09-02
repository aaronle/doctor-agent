"""
分享卡片的 meta。

这批测试盯的是**一个不会报错的失效**：标记被删或被压缩掉之后，注入静默失效，
所有路由共用同一张卡片，页面本身照常工作，没有任何异常。
"""

from __future__ import annotations

from pathlib import Path

from app.seo import DEFAULT, SEO_END, SEO_START, build_block, inject, meta_for

WEB = Path(__file__).resolve().parents[3] / "apps" / "web"


def test_each_page_gets_its_own_card():
    """三个页面转到群里应该是三张不同的卡片，不是同一张。"""
    titles = {meta_for(p)[0] for p in ("", "admin", "delivery")}
    assert len(titles) == 3


def test_longest_prefix_wins_and_subpaths_inherit():
    assert meta_for("admin/anything")[0] == meta_for("admin")[0]
    assert meta_for("delivery/")[0] == meta_for("delivery")[0]


def test_patient_pages_never_leak_who_the_visit_is_about():
    """
    就诊页刻意不单独配卡片。

    一条链接转出去，**卡片正文**里带着就诊人 ID 或姓名就是另一回事了 ——
    哪怕一期全是虚构病例，这个习惯也不能从这里开始破。

    `og:url` 是例外，它必须等于被分享的那条链接本身：收链接的人本来就看得见
    地址栏里的 P001，og:url 复述一遍不增加任何暴露，改成首页反而会让
    各平台的规范链接指错地方。所以这里断言的是标题与描述，不是整段。
    """
    title, description = meta_for("outpatient/P001")
    assert (title, description) == DEFAULT
    assert "P001" not in title and "P001" not in description

    block = build_block("outpatient/P001")
    leaked = [
        line for line in block.splitlines()
        if "P001" in line and 'property="og:url"' not in line
    ]
    assert not leaked, f"除 og:url 外不该出现就诊人标识：{leaked}"


def test_disclaimer_rides_along_on_every_page():
    """
    链接会被转发到群里，收到的人第一时间该知道这不是真实患者数据。
    """
    for path in ("", "admin", "delivery", "outpatient/P001"):
        assert "虚构病例" in build_block(path)


def test_image_url_is_absolute():
    """爬虫不认相对路径。给 /share-square.png 的话卡片就没有图。"""
    block = build_block("")
    assert 'content="https://' in block
    assert 'content="/share-square.png"' not in block


def test_share_image_is_square_not_wide():
    """
    微信把卡片图裁成方的。给 1200×630 会被拦腰切掉，
    横版留给别的平台（public/og-cover.png），不进 og:image。
    """
    assert "share-square.png" in build_block("")
    assert "og-cover.png" not in build_block("")


def test_injection_replaces_only_between_the_markers():
    html = f"<head>{SEO_START}<title>旧</title>{SEO_END}</head><body>正文</body>"
    out = inject(html, "admin")
    assert "<title>Agent 控制台 · Doctor Agent</title>" in out
    assert "<title>旧</title>" not in out
    assert "<body>正文</body>" in out


def test_missing_markers_degrade_quietly_instead_of_guessing():
    """
    标记不在就原样返回。硬塞进 <head> 看着稳妥，实际是把配置问题
    换成一个每次都要猜位置的字符串手术。
    """
    plain = "<html><head><title>原样</title></head></html>"
    assert inject(plain, "admin") == plain


def test_source_index_html_still_carries_the_markers():
    """
    源文件里的标记是这套机制的前提。删了不会报错，只会静默退化 ——
    所以要有一条测试守着，而不是等发现「所有页面卡片一样」再去查。
    """
    html = (WEB / "index.html").read_text(encoding="utf-8")
    assert SEO_START in html and SEO_END in html


def test_built_index_html_keeps_the_markers_if_a_build_exists():
    """
    真正会被爬虫读到的是构建产物。构建工具将来若开始压缩 HTML、
    把注释删掉，这条会红 —— 那正是需要提前知道的时刻。
    """
    built = WEB / "dist" / "index.html"
    if not built.exists():
        return  # 没构建过就跳过，不把「没跑 build」报成失败
    html = built.read_text(encoding="utf-8")
    assert SEO_START in html and SEO_END in html, "构建把 SEO 标记吃掉了，注入会静默失效"


def test_icons_referenced_by_index_html_actually_exist():
    """引用了不存在的图标 = 浏览器标签页一个默认地球图标，且不会报错。"""
    html = (WEB / "index.html").read_text(encoding="utf-8")
    for name in ("favicon.svg", "favicon-32.png", "apple-touch-icon.png"):
        assert name in html, f"index.html 没引用 {name}"
        assert (WEB / "public" / name).is_file(), f"public/ 下缺 {name}"


def test_share_image_file_exists():
    assert (WEB / "public" / "share-square.png").is_file()
