#!/usr/bin/env python3
"""Generate AI-SRE multi-agent dashboard HTML from live GitHub data."""
import json, subprocess, datetime, os

REPO_DIR = "/workspace/projects/project-aisre"
OUT = os.path.join(REPO_DIR, "dashboard", "multi-agent-dashboard.html")


def gh_json(args):
    p = subprocess.run(["gh"] + args, cwd=REPO_DIR, capture_output=True, text=True)
    if p.returncode != 0:
        return []
    try:
        return json.loads(p.stdout or "[]")
    except json.JSONDecodeError:
        return []


issues = gh_json(["issue", "list", "--state", "open", "--json", "number,title,labels,state,updatedAt"])
prs = gh_json(["pr", "list", "--state", "open", "--json", "number,title,headRefName,state,updatedAt"])

# Agent roster (role -> assigned task -> status). Update status as pipeline progresses.
roster = [
    {"agent": "PM (main)",         "role": "调度/协调", "task": "Epic #1 · 计划",   "status": "ACTIVE"},
    {"agent": "BA (req)",          "role": "需求分析",  "task": "T1 · SPEC",        "status": "DONE"},
    {"agent": "ARCH (arch)",       "role": "架构设计",  "task": "T2 · DESIGN",      "status": "DONE"},
    {"agent": "DEV (dev)",         "role": "实现",      "task": "T3 · IMPL",        "status": "RUNNING"},
    {"agent": "QA (qa)",           "role": "验证",      "task": "T4 · VERIFY",      "status": "WAITING"},
    {"agent": "DEVOPS (devops)",   "role": "部署",      "task": "T5 · DEPLOY",      "status": "WAITING"},
]

now = datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")

COLORS = {"ACTIVE": "#2da44e", "RUNNING": "#1f6feb", "WAITING": "#6e7781", "DONE": "#8250df"}


def badge(s):
    c = COLORS.get(s, "#6e7781")
    return f'<span style="background:{c};color:#fff;padding:2px 8px;border-radius:10px;font-size:11px">{s}</span>'


rows = "".join(
    f'<tr><td>{r["agent"]}</td><td>{r["role"]}</td><td>{r["task"]}</td><td>{badge(r["status"])}</td></tr>'
    for r in roster
)

issue_rows = "".join(
    f'<tr><td><a href="https://github.com/jchu-hk/project-aisre/issues/{i["number"]}">#{i["number"]}</a></td>'
    f'<td>{i["title"]}</td><td>{", ".join(l["name"] for l in i["labels"])}</td></tr>'
    for i in issues
) or '<tr><td colspan="3">(none)</td></tr>'

pr_rows = "".join(
    f'<tr><td><a href="https://github.com/jchu-hk/project-aisre/pull/{p["number"]}">#{p["number"]}</a></td>'
    f'<td>{p["title"]}</td><td>{p["headRefName"]}</td></tr>'
    for p in prs
) or '<tr><td colspan="3">(none)</td></tr>'

html = f"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI-SRE Multi-Agent Dashboard</title>
<style>
 body {{ font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; color: #1f2328; background: #f6f8fa; }}
 h1 {{ font-size: 20px; }} .sub {{ color: #6e7781; font-size: 13px; }}
 h2 {{ font-size: 15px; margin: 0 0 8px; }}
 table {{ border-collapse: collapse; width: 100%; background: #fff; margin: 8px 0; box-shadow: 0 1px 3px rgba(0,0,0,.08); }}
 th, td {{ text-align: left; padding: 10px 12px; border-bottom: 1px solid #eaeef2; font-size: 13px; }}
 th {{ background: #f6f8fa; }}
 .card {{ background:#fff; padding: 16px; margin: 16px 0; box-shadow: 0 1px 3px rgba(0,0,0,.08); border-radius: 6px; }}
 a {{ color: #0969da; text-decoration: none; }}
</style>
</head>
<body>
<h1>AI-SRE · Multi-Agent Dashboard</h1>
<div class="sub">project-aisre · 更新于 {now} · <a href="https://github.com/jchu-hk/project-aisre">repo</a> · <a href="https://github.com/jchu-hk/project-aisre/issues/1">Epic #1</a></div>

<div class="card">
<h2>Agent 分工与状态</h2>
<table><tr><th>Agent</th><th>角色</th><th>任务</th><th>状态</th></tr>{rows}</table>
</div>

<div class="card">
<h2>Open Issues</h2>
<table><tr><th>#</th><th>标题</th><th>Labels</th></tr>{issue_rows}</table>
</div>

<div class="card">
<h2>Open PRs</h2>
<table><tr><th>#</th><th>标题</th><th>分支</th></tr>{pr_rows}</table>
</div>
</body>
</html>"""

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)
print(f"wrote {OUT} ({len(html)} bytes)")
