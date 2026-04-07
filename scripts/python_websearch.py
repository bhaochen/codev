#!/usr/bin/env python3
"""
Python WebSearch Script - 使用 ddgs 库进行搜索
"""
import sys
import json
from ddgs import DDGS

def search(query, max_results=10):
    """使用 ddgs 进行搜索"""
    try:
        ddgs = DDGS(timeout=10)
        results = ddgs.text(query, max_results=max_results)
        
        formatted_results = []
        for r in results:
            formatted_results.append({
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "snippet": r.get("body", "")[:500]
            })
        
        print(json.dumps({
            "success": True,
            "query": query,
            "results": formatted_results,
            "count": len(formatted_results)
        }, ensure_ascii=False))
        
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e),
            "query": query
        }, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({
            "success": False,
            "error": "Missing query parameter"
        }, ensure_ascii=False))
        sys.exit(1)
    
    query = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    search(query, max_results)
