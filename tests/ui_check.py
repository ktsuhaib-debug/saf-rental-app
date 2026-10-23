"""Browser test: sign in, check out a car with photos and a signature, make the agreement PDF.
Run the local server first: node tests/serve.mjs 8799
"""
import sys, re, os
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8799'
OUT = os.path.join(os.path.dirname(__file__), '.out')
os.makedirs(OUT, exist_ok=True)
errors = []

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)

    page.goto(BASE + '/')
    page.click('[data-act="pickLogin"][data-v="ANEES"]')
    page.fill('#loginPin', '2222')
    page.click('#loginBtn')
    page.wait_for_selector('#fab:not([hidden])', timeout=15000)
    page.screenshot(path=os.path.join(OUT, '1-home.png'))
    print('signed in, home shown')

    # A photo to attach: a screenshot of the home screen
    photo = os.path.join(OUT, '1-home.png')
    page.click('[data-act="checkout"]')
    page.wait_for_selector('#co_name')
    page.fill('#co_name', 'Nithin Raj')
    page.fill('#co_mobile', '9446033445')
    page.fill('#co_startOdo', '12000')
    page.fill('#co_rate', '1800')
    page.fill('#co_deposit', '5000')
    page.fill('#co_advance', '1000')
    page.set_input_files('input[data-photo-key="id"]', photo)
    page.set_input_files('input[data-photo-key="out"]', [photo, photo])
    page.wait_for_function("document.querySelectorAll('#ph-out .ph').length === 2", timeout=10000)
    c = page.locator('#sigCanvas'); c.scroll_into_view_if_needed(); box = c.bounding_box()
    page.mouse.move(box['x'] + 20, box['y'] + 60); page.mouse.down()
    for i in range(1, 30): page.mouse.move(box['x'] + 20 + i * 9, box['y'] + 60 + (25 if i % 2 else -25))
    page.mouse.up()
    page.screenshot(path=os.path.join(OUT, '2-checkout-form.png'))
    page.click('#submitBtn')
    page.wait_for_selector('[data-act="agreement"]', timeout=15000)
    print('checked out, agreement offered')
    page.click('.sheet [data-act="agreement"], #modal [data-act="agreement"]')
    page.wait_for_selector('#pdfBox a.btn:has-text("Open PDF")', timeout=40000)
    page.screenshot(path=os.path.join(OUT, '3-pdf-ready.png'))
    href = page.get_attribute('#pdfBox a.btn:has-text("Open PDF")', 'href')
    wa = page.get_attribute('#pdfBox a:has-text("WhatsApp")', 'href') or ''
    print('pdf link:', href)
    assert re.match('^' + re.escape(BASE) + r'/doc/[0-9a-f]{40}/', href), href
    assert '%2Fdoc%2F' in wa, wa
    r = page.request.get(href)
    data = r.body()
    assert r.status == 200 and data[:5] == b'%PDF-', (r.status, data[:20])
    open(os.path.join(OUT, 'agreement.pdf'), 'wb').write(data)
    print('pdf bytes:', len(data))

    # Monthly statement PDF (Partners tab)
    page.click('[data-act="close"]')
    page.click('#tabs [data-view="partners"]')
    page.wait_for_selector('[data-act="statement"]')
    page.click('[data-act="statement"]')
    page.wait_for_selector('#pdfBox a.btn:has-text("Open PDF")', timeout=40000)
    href = page.get_attribute('#pdfBox a.btn:has-text("Open PDF")', 'href')
    r = page.request.get(href); data = r.body()
    assert r.status == 200 and data[:5] == b'%PDF-'
    open(os.path.join(OUT, 'statement.pdf'), 'wb').write(data)
    print('statement pdf bytes:', len(data))

    # Trip photos load through signed links
    page.click('[data-act="close"]')
    page.click('#tabs [data-view="trips"]')
    page.wait_for_timeout(500)
    page.click('text=Nithin Raj >> nth=0')
    page.wait_for_function("Array.from(document.querySelectorAll('#modal img')).filter(i => /\\/photo\\//.test(i.src) && i.naturalWidth > 0).length >= 2", timeout=15000)
    page.screenshot(path=os.path.join(OUT, '4-trip-photos.png'))
    print('trip photos shown')

    # Photos load through signed links
    page.click('[data-act="close"]') if page.locator('[data-act="close"]').count() else None
    page.reload()
    page.wait_for_selector('#fab:not([hidden])', timeout=15000)
    print('reloaded, still signed in')
    b.close()

bad = [e for e in errors if 'favicon' not in e and 'ERR_TUNNEL_CONNECTION_FAILED' not in e]  # Google Fonts are blocked in the test sandbox
if bad:
    print('BROWSER ERRORS:'); [print(' ', e) for e in bad]; sys.exit(1)
print('UI check passed')
