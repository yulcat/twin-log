#!/usr/bin/env python3
"""
twin-summary.py — 진우+주하 야간 요약 리포트

매일 아침(기본 06:00) 어젯밤(전날 20:00 ~ 오늘 07:00)의 
수유/수면/기저귀 기록을 집계해서 사장님에게 Discord DM 발송.

사용법:
  python3 twin-summary.py            # 야간 요약 (기본)
  python3 twin-summary.py --test     # 테스트 (오늘 전체 데이터 + 메시지 출력만)
"""
import sys
import json
import urllib.request
from datetime import datetime, timezone, timedelta

TWIN_LOG_API = "http://localhost:3468/api/events"
OPENCLAW_HOOK = "http://127.0.0.1:18789/hooks/agent"
OPENCLAW_TOKEN = "ha-hook-secret"
DISCORD_USER = "301760466659835905"  # 사장님 DM

BABY_NAMES = {"a": "진우", "b": "주하"}
BABY_EMOJI = {"a": "🔵", "b": "🔴"}


def fetch_events_between(start: datetime, end: datetime) -> list:
    """start~end 사이의 이벤트 가져오기."""
    events = []
    
    # 날짜별로 fetch (경계 넘는 경우 양쪽 날 모두)
    dates = set()
    current = start
    while current <= end:
        dates.add(current.strftime("%Y-%m-%d"))
        current += timedelta(days=1)
    
    for date in sorted(dates):
        url = f"{TWIN_LOG_API}?date={date}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "twin-summary/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                day_events = json.loads(resp.read())
            events.extend(day_events)
        except Exception as e:
            print(f"[twin-summary] API 오류 ({date}): {e}")
    
    # start~end 사이 이벤트만 필터
    def in_range(e: dict) -> bool:
        ts = e.get("startTime", "")
        if not ts:
            return False
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return start <= dt <= end
        except Exception:
            return False
    
    return [e for e in events if in_range(e)]


def parse_iso(ts: str) -> datetime | None:
    """ISO 문자열 파싱."""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def duration_minutes(event: dict) -> float | None:
    """이벤트 지속시간(분) 계산. endTime이 없으면 None."""
    start = parse_iso(event.get("startTime"))
    end = parse_iso(event.get("endTime"))
    if not start or not end:
        return None
    return (end - start).total_seconds() / 60


def summarize_baby(events: list, baby: str) -> dict:
    """아기별 집계 데이터 계산."""
    mine = [e for e in events if e.get("baby") == baby]
    
    # 수유 집계
    FEED_TYPES = {
        "feeding_breast_left": "모유(좌)",
        "feeding_breast_right": "모유(우)",
        "feeding_bottle": "분유",
    }
    feeds = [e for e in mine if e.get("type") in FEED_TYPES]
    feed_count = len(feeds)
    
    # 모유/분유 구분
    breast_count = sum(1 for e in feeds if e.get("type") in ["feeding_breast_left", "feeding_breast_right"])
    bottle_count = sum(1 for e in feeds if e.get("type") == "feeding_bottle")
    
    # 분유 총량
    total_bottle_ml = sum(
        e.get("amount", 0) or 0 
        for e in feeds 
        if e.get("type") == "feeding_bottle" and e.get("amount")
    )
    
    # 모유 총 수유 시간
    breast_total_min = sum(
        duration_minutes(e) or 0
        for e in feeds
        if e.get("type") in ["feeding_breast_left", "feeding_breast_right"]
    )
    
    # 마지막 수유 시각
    if feeds:
        last_feed = max(feeds, key=lambda e: e.get("startTime", ""))
        last_feed_dt = parse_iso(last_feed.get("startTime"))
    else:
        last_feed_dt = None
    
    # 수면 집계
    sleeps = [e for e in mine if e.get("type") == "sleep" and e.get("endTime")]
    sleep_count = len(sleeps)
    total_sleep_min = sum(duration_minutes(e) or 0 for e in sleeps)
    
    # 기저귀 집계
    diapers = [e for e in mine if e.get("type") in ["diaper_wet", "diaper_dirty", "diaper_both"]]
    diaper_count = len(diapers)
    dirty_count = sum(1 for e in diapers if e.get("type") == "diaper_dirty")
    
    return {
        "baby": baby,
        "name": BABY_NAMES[baby],
        "emoji": BABY_EMOJI[baby],
        # 수유
        "feed_count": feed_count,
        "breast_count": breast_count,
        "bottle_count": bottle_count,
        "total_bottle_ml": int(total_bottle_ml),
        "breast_total_min": int(breast_total_min),
        "last_feed_dt": last_feed_dt,
        # 수면
        "sleep_count": sleep_count,
        "total_sleep_hours": round(total_sleep_min / 60, 1),
        # 기저귀
        "diaper_count": diaper_count,
        "dirty_count": dirty_count,
    }


def format_time_korean(dt: datetime | None) -> str:
    if not dt:
        return "기록 없음"
    local = dt.astimezone()
    hour = local.hour
    minute = local.minute
    if hour < 12:
        return f"오전 {hour}:{minute:02d}"
    else:
        return f"오후 {hour - 12 if hour > 12 else 12}:{minute:02d}"


def build_report(summaries: list[dict], period_label: str) -> str:
    """Discord 메시지 포맷."""
    lines = [
        f"🌅 **둥이들 야간 요약** — {period_label}",
        "",
    ]
    
    for s in summaries:
        name = s["name"]
        emoji = s["emoji"]
        
        lines.append(f"**{emoji} {name}**")
        
        # 수유
        if s["feed_count"] == 0:
            lines.append("  🍼 수유: 기록 없음")
        else:
            feed_parts = []
            if s["breast_count"] > 0:
                feed_parts.append(f"모유 {s['breast_count']}회")
                if s["breast_total_min"] > 0:
                    feed_parts.append(f"({s['breast_total_min']}분)")
            if s["bottle_count"] > 0:
                feed_parts.append(f"분유 {s['bottle_count']}회")
                if s["total_bottle_ml"] > 0:
                    feed_parts.append(f"(총 {s['total_bottle_ml']}ml)")
            lines.append(f"  🍼 수유 {s['feed_count']}회: " + " ".join(feed_parts))
        
        # 수면
        if s["sleep_count"] == 0:
            lines.append("  💤 수면: 기록 없음")
        else:
            lines.append(f"  💤 수면 {s['sleep_count']}회: 총 {s['total_sleep_hours']}시간")
        
        # 기저귀
        if s["diaper_count"] == 0:
            lines.append("  🚼 기저귀: 기록 없음")
        else:
            diaper_desc = f"{s['diaper_count']}회"
            if s["dirty_count"] > 0:
                diaper_desc += f" (응가 {s['dirty_count']}회 포함)"
            lines.append(f"  🚼 기저귀: {diaper_desc}")
        
        # 마지막 수유
        lines.append(f"  ⏰ 마지막 수유: {format_time_korean(s['last_feed_dt'])}")
        lines.append("")
    
    # 합계 (데이터 있는 경우)
    total_feeds = sum(s["feed_count"] for s in summaries)
    total_diapers = sum(s["diaper_count"] for s in summaries)
    
    if total_feeds > 0 or total_diapers > 0:
        lines.append("─────────────────")
        lines.append(f"📊 합계: 수유 {total_feeds}회 | 기저귀 {total_diapers}회")
    
    return "\n".join(lines)


def send_report(message: str):
    """사장님에게 Discord DM 발송."""
    payload = json.dumps({
        "message": f"{message}\n\n사장님 Discord DM으로 이 요약을 전달해줘.",
        "name": "TwinSummary",
        "deliver": True,
        "channel": "discord",
        "to": DISCORD_USER,
        "wakeMode": "now"
    }).encode()
    
    req = urllib.request.Request(
        OPENCLAW_HOOK,
        data=payload,
        headers={
            "Authorization": f"Bearer {OPENCLAW_TOKEN}",
            "Content-Type": "application/json"
        }
    )
    
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        print(f"[twin-summary] 발송 성공: {resp.status}")
    except Exception as e:
        print(f"[twin-summary] 발송 실패: {e}")


def main():
    test_mode = "--test" in sys.argv
    
    now = datetime.now(timezone.utc)
    
    if test_mode:
        # 테스트: 오늘 전체
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = now
        period_label = "오늘 (테스트)"
        print(f"[twin-summary] 테스트 모드: {start.strftime('%Y-%m-%d %H:%M')} ~ {end.strftime('%H:%M')}")
    else:
        # 야간 요약: 전날 20:00 ~ 오늘 07:00 (한국 기준)
        # UTC+9 → UTC 변환: 20:00 KST = 11:00 UTC, 07:00 KST = 22:00 UTC (전날)
        kst = timezone(timedelta(hours=9))
        now_kst = now.astimezone(kst)
        today_kst = now_kst.date()
        yesterday_kst = today_kst - timedelta(days=1)
        
        # 어제 20:00 KST
        start_kst = datetime(yesterday_kst.year, yesterday_kst.month, yesterday_kst.day, 20, 0, 0, tzinfo=kst)
        # 오늘 07:00 KST
        end_kst = datetime(today_kst.year, today_kst.month, today_kst.day, 7, 0, 0, tzinfo=kst)
        
        start = start_kst.astimezone(timezone.utc)
        end = end_kst.astimezone(timezone.utc)
        
        period_label = f"{yesterday_kst.strftime('%m/%d')} 밤 ~ {today_kst.strftime('%m/%d')} 아침"
        print(f"[twin-summary] 야간 집계: {period_label}")
    
    events = fetch_events_between(start, end)
    print(f"[twin-summary] 이벤트 {len(events)}개 로드")
    
    summaries = [
        summarize_baby(events, "a"),
        summarize_baby(events, "b"),
    ]
    
    report = build_report(summaries, period_label)
    
    if test_mode:
        print("\n" + "="*50)
        print(report)
        print("="*50)
        print("(테스트 모드: Discord DM 미전송)")
    else:
        if len(events) == 0:
            print("[twin-summary] 이벤트 없음 — 스킵 (출산 전이거나 기록 없음)")
        else:
            send_report(report)


if __name__ == "__main__":
    main()
