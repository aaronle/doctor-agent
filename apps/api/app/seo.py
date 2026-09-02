"""
按路由生成分享卡片的 meta，并注入 SPA 的 index.html。

**为什么必须在服务端做。** 微信、以及绝大多数抓链接的爬虫都不执行 JavaScript。
这是个 Vue SPA —— 前端注入的 `<title>` 与 og 标签它们一个都读不到，
抓到的永远是构建产物里那份静态 HTML。所以要让 `/`、`/admin`、`/delivery`
在聊天里显示成三张不同的卡片，只能由服务端在下发 HTML 时替换。

**能做到什么、做不到什么，说清楚：**

- 能做到：把该给的都按规范给全（title / description / og:* / itemprop=image），
  favicon 与 iOS 添加到主屏的图标一并解决。
- 做不到：**保证微信一定照着显示**。微信对普通网页链接的卡片渲染没有公开契约，
  想要确定性得用公众号 + JS-SDK 签名，那套凭据这个项目没有。
"""

from __future__ import annotations

import os
from html import escape

#: 构建产物里的替换标记。index.html 里有对应的注释说明为什么不能删。
SEO_START = "<!--SEO:START-->"
SEO_END = "<!--SEO:END-->"

#: 分享图与 og:url 用的绝对地址。爬虫不认相对路径，必须给完整 URL。
PUBLIC_ORIGIN = os.environ.get("DOCTOR_AGENT_PUBLIC_ORIGIN", "https://da.aaronhealth.cn").rstrip("/")

#: 微信把卡片图裁成正方形，所以 og:image 给方图而不是 1200×630 的横图 ——
#: 横图会被拦腰切掉。横版留给别的平台，见 public/og-cover.png。
SHARE_IMAGE = "/share-square.png"

SITE_NAME = "Doctor Agent"

#: 所有页面共用的尾巴。**这句话是有意放进去的** —— 这个链接会被转发到微信群里，
#: 收到的人第一时间该知道它不含真实患者数据，而不是点进去自己猜。
DISCLAIMER = "演示环境，全部为虚构病例，不含真实患者数据。"

DEFAULT = (
    "Doctor Agent · AI 门诊工作站",
    f"医生超级智能体：语音问诊、病历生成、鉴别诊断、风险与共病管理。{DISCLAIMER}",
)

#: 前缀 → (标题, 描述)。**按最长前缀匹配**，顺序无关。
#:
#: 就诊页（/outpatient/P001 之类）刻意不单独配：卡片里绝不出现任何就诊人信息，
#: 哪怕是虚构的。一条链接转出去，标题里带着人名就是另一回事了。
ROUTES: dict[str, tuple[str, str]] = {
    "/admin": (
        "Agent 控制台 · Doctor Agent",
        f"六个岗位的配置、试运行、并排对比与回归集，运行日志可查。{DISCLAIMER}",
    ),
    "/delivery": (
        "交付平台 · Doctor Agent",
        f"功能线与智能体线并排：门禁逐项、部署过程、发布历史与生产指纹。{DISCLAIMER}",
    ),
}


def meta_for(path: str) -> tuple[str, str]:
    """按最长前缀取这条路径的标题与描述。"""
    normalized = "/" + path.strip("/")
    best = ""
    for prefix in ROUTES:
        if (normalized == prefix or normalized.startswith(prefix + "/")) and len(prefix) > len(best):
            best = prefix
    return ROUTES[best] if best else DEFAULT


def build_block(path: str) -> str:
    """生成要塞进 `<head>` 的那一段。"""
    title, description = meta_for(path)
    t, d = escape(title, quote=True), escape(description, quote=True)
    image = f"{PUBLIC_ORIGIN}{SHARE_IMAGE}"
    url = f"{PUBLIC_ORIGIN}/" + path.strip("/")

    return "\n".join(
        [
            f"<title>{t}</title>",
            f'<meta name="description" content="{d}" />',
            '<meta property="og:type" content="website" />',
            f'<meta property="og:site_name" content="{SITE_NAME}" />',
            f'<meta property="og:title" content="{t}" />',
            f'<meta property="og:description" content="{d}" />',
            f'<meta property="og:url" content="{escape(url, quote=True)}" />',
            f'<meta property="og:image" content="{image}" />',
            # 微信在部分场景下读的是 itemprop 而不是 og，两个都给
            f'<meta itemprop="image" content="{image}" />',
            f'<meta itemprop="name" content="{t}" />',
            f'<meta itemprop="description" content="{d}" />',
        ]
    )


def inject(html: str, path: str) -> str:
    """
    把两个标记之间的内容替换掉。

    **标记不在就原样返回，不抛错、不硬塞。** 硬塞进 `<head>` 看着更"稳妥"，
    实际上是把一个配置问题变成一个每次都要猜位置的字符串手术；
    而原样返回至少页面还是好的，只是所有路由共用同一张卡片 ——
    部署脚本会比对 / 与 /admin 的标题，那一步会把它抓出来。
    """
    start = html.find(SEO_START)
    end = html.find(SEO_END)
    if start == -1 or end == -1 or end < start:
        return html
    return html[: start + len(SEO_START)] + "\n" + build_block(path) + "\n" + html[end:]
