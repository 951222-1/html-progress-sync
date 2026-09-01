#!/usr/bin/env python3
"""
Antigravity Cross-Computer AI Sync Tool (ai_sync.py)
---------------------------------------------------
This tool allows an AI or automated script on another computer to:
1. List all progress reports in the database index.
2. PULL / Download missing HTML progress reports locally into `synced_html/`.
3. PUSH / Upload new HTML progress reports to the GitHub repository database.

Usage:
  python ai_sync.py list --owner USER --repo REPO [--token TOKEN]
  python ai_sync.py pull --owner USER --repo REPO [--token TOKEN] [--output ./synced_html]
  python ai_sync.py push --owner USER --repo REPO --token TOKEN --title "Task Title" --file report.html [--status completed]
"""

import os
import sys
import json
import base64
import argparse
import urllib.request
import urllib.error
from datetime import datetime

GITHUB_API_BASE = "https://api.github.com/repos"

def make_request(url, method="GET", token=None, body=None):
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Antigravity-AI-Sync-Tool"
    }
    if token:
        headers["Authorization"] = f"token {token}"
    
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers["Content-Type"] = "application/json"
        
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            content = resp.read().decode('utf-8')
            if content:
                return json.loads(content)
            return {}
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode('utf-8')
        print(f"[ERROR] HTTP {e.code}: {err_msg}", file=sys.stderr)
        raise e

def fetch_index(owner, repo, branch="main", token=None):
    """Fetch data/index.json from GitHub repository via REST API or Raw fallback."""
    url = f"{GITHUB_API_BASE}/{owner}/{repo}/contents/data/index.json?ref={branch}"
    try:
        res = make_request(url, token=token)
        content_b64 = res.get("content", "")
        sha = res.get("sha", "")
        raw_json = base64.b64decode(content_b64).decode('utf-8')
        data = json.loads(raw_json)
        data["_sha"] = sha
        return data
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"[WARN] data/index.json not found in repository. Initializing empty DB.")
            return {"last_id": 0, "updated_at": "", "items": []}
        raise e

def cmd_list(args):
    """List all progress reports in terminal."""
    db = fetch_index(args.owner, args.repo, args.branch, args.token)
    items = db.get("items", [])
    print("\n=======================================================")
    print(f" Progress Database List (Repo: {args.owner}/{args.repo})")
    print(f" Total: {len(items)} | Latest Serial ID: #{db.get('last_id', 0):04d}")
    print("=======================================================")
    print(f"{'ID':<8} {'Status':<12} {'Author':<15} {'Title'}")
    print("-------------------------------------------------------")
    for item in sorted(items, key=lambda x: int(x['id'])):
        status_tag = f"[{item.get('status', 'N/A')}]"
        print(f"#{item['id']:<7} {status_tag:<12} {item.get('author', 'N/A'):<15} {item['title']}")
    print("=======================================================\n")

def cmd_pull(args):
    """Download missing HTML progress files locally."""
    db = fetch_index(args.owner, args.repo, args.branch, args.token)
    items = db.get("items", [])
    out_dir = args.output
    os.makedirs(out_dir, exist_ok=True)

    print(f"[INFO] 讀取遠端索引成功，共有 {len(items)} 個工作進度報告...")
    
    downloaded_count = 0
    for item in items:
        file_id = item['id']
        filename = item.get('filename') or f"{file_id}_progress.html"
        local_path = os.path.join(out_dir, filename)

        if os.path.exists(local_path):
            print(f"  [SKIPPED] 序號 #{file_id} ({filename}) 已存在本地")
            continue

        print(f"  [DOWNLOADING] 下載序號 #{file_id}: {item['title']} -> {local_path}")
        file_rel_path = item.get('download_url') or f"data/html/{filename}"
        file_api_url = f"{GITHUB_API_BASE}/{args.owner}/{args.repo}/contents/{file_rel_path}?ref={args.branch}"
        
        try:
            file_res = make_request(file_api_url, token=args.token)
            content_b64 = file_res.get("content", "")
            raw_html = base64.b64decode(content_b64).decode('utf-8')
            
            with open(local_path, "w", encoding="utf-8") as f:
                f.write(raw_html)
            downloaded_count += 1
        except Exception as err:
            print(f"  [ERROR] 下載序號 #{file_id} 失敗: {err}", file=sys.stderr)

    print(f"\n[SUCCESS] 同步完成！共下載 {downloaded_count} 個新檔案至 '{out_dir}/'。\n")

def cmd_push(args):
    """Upload a new progress HTML file and update sequence number."""
    if not args.token:
        print("[ERROR] PUSH 操作必須提供 --token (GitHub Personal Access Token)", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(args.file):
        print(f"[ERROR] 找不到指定的 HTML 檔案: {args.file}", file=sys.stderr)
        sys.exit(1)

    with open(args.file, "r", encoding="utf-8") as f:
        html_content = f.read()

    db = fetch_index(args.owner, args.repo, args.branch, args.token)
    next_id = int(db.get("last_id", 0)) + 1
    id_str = f"{next_id:04d}"

    safe_title = "".join([c if c.isalnum() else "_" for c in args.title])[:30]
    filename = f"{id_str}_{safe_title}.html"
    rel_path = f"data/html/{filename}"

    # 1. Upload HTML file
    print(f"[INFO] 正在上傳 HTML 進度報告 #{id_str} ({filename})...")
    html_b64 = base64.b64encode(html_content.encode('utf-8')).decode('utf-8')
    put_file_url = f"{GITHUB_API_BASE}/{args.owner}/{args.repo}/contents/{rel_path}"
    
    make_request(put_file_url, method="PUT", token=args.token, body={
        "message": f"Add progress #{id_str}: {args.title}",
        "content": html_b64,
        "branch": args.branch
    })

    # 2. Update data/index.json
    new_item = {
        "id": id_str,
        "title": args.title,
        "author": args.author,
        "status": args.status,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "summary": args.summary,
        "filename": filename,
        "download_url": rel_path
    }

    db["items"].append(new_item)
    db["last_id"] = next_id
    db["updated_at"] = datetime.utcnow().isoformat() + "Z"

    current_sha = db.pop("_sha", None)

    index_json_str = json.dumps(db, indent=2, ensure_ascii=False)
    index_b64 = base64.b64encode(index_json_str.encode('utf-8')).decode('utf-8')
    put_index_url = f"{GITHUB_API_BASE}/{args.owner}/{args.repo}/contents/data/index.json"

    put_body = {
        "message": f"Update progress index for #{id_str}",
        "content": index_b64,
        "branch": args.branch
    }
    if current_sha:
        put_body["sha"] = current_sha

    make_request(put_index_url, method="PUT", token=args.token, body=put_body)

    print(f"[SUCCESS] 成功建立並上傳進度報告 #{id_str}！\n")

def main():
    parser = argparse.ArgumentParser(description="Antigravity Cross-Computer AI Sync CLI Tool")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Common arguments
    common_parser = argparse.ArgumentParser(add_help=False)
    common_parser.add_argument("--owner", required=True, help="GitHub 帳號 (Owner)")
    common_parser.add_argument("--repo", required=True, help="GitHub Repository 名稱")
    common_parser.add_argument("--branch", default="main", help="GitHub 分支 (預設: main)")
    common_parser.add_argument("--token", help="GitHub Personal Access Token (PAT)")

    # List command
    parser_list = subparsers.add_parser("list", parents=[common_parser], help="列出資料庫中所有進度與序號")

    # Pull command
    parser_pull = subparsers.add_parser("pull", parents=[common_parser], help="下載並同步遠端未下載的 HTML 進度報告")
    parser_pull.add_argument("--output", default="./synced_html", help="下載儲存目錄 (預設: ./synced_html)")

    # Push command
    parser_push = subparsers.add_parser("push", parents=[common_parser], help="上傳新的 HTML 進度報告並自動分配遞增序號")
    parser_push.add_argument("--file", required=True, help="要上傳的本地 HTML 檔案路徑")
    parser_push.add_argument("--title", required=True, help="任務與進度標題")
    parser_push.add_argument("--author", default="AI Assistant", help="提交者名稱 (預設: AI Assistant)")
    parser_push.add_argument("--status", default="completed", choices=["completed", "in_progress", "pending"], help="進度狀態")
    parser_push.add_argument("--summary", default="", help="進度摘要簡述")

    args = parser.parse_args()

    if args.command == "list":
        cmd_list(args)
    elif args.command == "pull":
        cmd_pull(args)
    elif args.command == "push":
        cmd_push(args)

if __name__ == "__main__":
    main()
