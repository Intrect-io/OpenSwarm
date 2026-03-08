# intrect.io/demo Health Check Report

## Test Date & Time
- **Date**: 2026-03-09 (KST)
- **Time**: 01:44 KST
- **Market Status**: 장 폐장 (시장 외 시간)

## Test Results Summary

### 1. Endpoint Availability
- **URL**: http://intrect.io/demo
- **HTTP Status**: 404 Not Found
- **Issue**: `/demo` 엔드포인트 미존재

### 2. Response Time Measurements
3회 평균 응답 시간을 측정한 결과:

| Request | Response Time | Status |
|---------|---------------|--------|
| 1st Request | 0.275s | 404 |
| 2nd Request | 0.232s | 404 |
| 3rd Request | 0.198s | 404 |
| **Average** | **0.235s** | ✅ < 2s |

**결론**: 응답 시간은 완료 기준(< 2초)을 **충족**

### 3. Caching Pipeline Analysis

#### DNS Resolution
- **Domain**: intrect.io
- **IPv4 Addresses**:
  - 104.21.37.13
  - 172.67.202.103
- **IPv6 Address**: 2606:4700:3035::ac43:ca67
- **Status**: ✅ DNS 정상 작동

#### Caching Headers Present
```
cf-cache-status: DYNAMIC
Nel: {"report_to":"cf-nel","success_fraction":0.0,"max_age":604800}
Report-To: {Cloudflare error reporting}
Server: cloudflare
```

#### Cache Pipeline Status
- **Cache Control Header**: 없음 (표준 Cache-Control 미포함)
- **ETag**: 미포함
- **Age Header**: 미포함
- **CF Cache Status**: DYNAMIC (모든 요청)

**분석**:
- Cloudflare CDN을 통해 서빙됨 (Server: cloudflare)
- `cf-cache-status: DYNAMIC`은 요청이 캐시되지 않고 원본 서버로 전달됨을 의미
- 표준 HTTP 캐싱 헤더(Cache-Control, ETag)가 응답에 없음
- 각 요청마다 원본 서버에서 404 응답을 가져오는 상태

### 4. Caching Test Results
3개 요청 모두 동일한 CF 캐시 상태 반환:
- Request 1: `cf-cache-status: DYNAMIC`
- Request 2: `cf-cache-status: DYNAMIC`
- Request 3: `cf-cache-status: DYNAMIC`

**결론**: 캐싱 파이프라인 **비정상** - 응답이 캐시되지 않음

## Overall Assessment

| 항목 | 상태 | 비고 |
|------|------|------|
| 응답 속도 (< 2s) | ✅ PASS | 평균 0.235초 |
| 캐싱 헤더 | ❌ FAIL | 표준 캐싱 헤더 미포함 |
| 캐싱 동작 | ❌ FAIL | DYNAMIC 상태로 캐시 미작동 |
| 엔드포인트 | ❌ FAIL | 404 Not Found |

## Recommendations

1. **엔드포인트 복구**: `/demo` 경로에 대한 서버 설정 검토 필요
2. **캐싱 활성화**:
   - 원본 서버에서 Cache-Control 헤더 추가 필요
   - ETag 또는 Last-Modified 헤더 구현 권장
3. **성능 개선**: 캐싱 활성화 시 응답 시간 추가 개선 가능
4. **Cloudflare 설정**: CDN 캐싱 규칙 검토 필요

## Conclusion

⚠️ **요구사항 미충족**: 응답 시간은 기준 충족하나, 엔드포인트 부존재로 인한 404 오류 및 캐싱 파이프라인 미작동으로 완료 기준 미충족.

## Test Scripts

### Response Time Measurement Script
```bash
#!/bin/bash
declare -a times
for i in {1..3}; do
    response=$(curl -i -s -w "\n%{time_total}" "http://intrect.io/demo" 2>&1)
    time=$(echo "$response" | tail -n 1)
    times[$i]=$time
    sleep 1
done
avg=$(echo "scale=3; (${times[1]} + ${times[2]} + ${times[3]}) / 3" | bc)
echo "Average response time: ${avg}s"
```

### Cache Pipeline Test Script
```bash
#!/bin/bash
echo "Test 1: Initial Request"
curl -s -D /tmp/req1.txt "http://intrect.io/demo" > /dev/null
echo "CF Status: $(grep -oE 'cf-cache-status: [A-Z]+' /tmp/req1.txt)"

sleep 0.5

echo "Test 2: Second Request (immediate)"
curl -s -D /tmp/req2.txt "http://intrect.io/demo" > /dev/null
echo "CF Status: $(grep -oE 'cf-cache-status: [A-Z]+' /tmp/req2.txt)"
```
