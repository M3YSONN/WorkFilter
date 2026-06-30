/**
 * Search scraper for OLX.pl and Pracuj.pl
 * ----------------------------------------
 * Run with: node scraper.js
 * Walks you through a few prompts (platform / category / city / keyword),
 * builds a search URL, opens up to 20 results, and appends a short summary
 * of each one to smart_search_results.txt (saved next to this script).
 *
 * Requires: Node.js 18+, `npm install puppeteer`
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Resolved relative to this script's folder, so results always land in a
// predictable place no matter which directory you run `node scraper.js` from.
const OUTPUT_FILE = path.join(__dirname, 'smart_search_results.txt');

// Converts user input into a URL-friendly slug.
// Examples: "Poznań" -> "poznan", "iPhone 13" -> "iphone-13", "Łódź" -> "lodz"
function formatForUrl(text) {
    return text
        .trim()
        .toLowerCase()
        .replace(/ł/g, 'l')              // "ł" has NO Unicode decomposition, so .normalize('NFD')
                                          // below does NOT turn it into "l" on its own - it has to be
                                          // handled explicitly, or city names like "Łódź"/"Wrocław"
                                          // silently keep their "ł" in the URL.
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // strips remaining diacritics (ą, ć, ę, ń, ó, ś, ź, ż -> a, c, e, n, o, s, z, z)
        .replace(/[^a-z0-9\s-]/g, '')    // drop anything that isn't a letter, digit, space or hyphen (commas, +, etc.)
        .replace(/\s+/g, '-')            // spaces -> hyphens
        .replace(/-+/g, '-')             // collapse repeated hyphens
        .replace(/^-+|-+$/g, '');        // trim leading/trailing hyphens
}

async function startScraping(url, platform, category) {
    console.log(`\n🚀 Starting browser for ${platform}...`);

    const isPracuj = platform === 'Pracuj.pl';

    // Pracuj.pl seems to detect headless Chrome more aggressively, so it runs
    // in a real, visible window (defaultViewport: null + maximized so the
    // page renders at a normal desktop size instead of the 800x600 default).
    // OLX behaves fine headless, which is faster and needs no display.
    const launchOptions = isPracuj
        ? { headless: false, defaultViewport: null, args: ['--start-maximized'] }
        : { headless: 'new' };

    const browser = await puppeteer.launch(launchOptions);

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        // Request interception only for the headless (OLX) path: Pracuj.pl runs
        // headed, and blocking resources there tends to make bot-detection
        // more suspicious rather than less.
        if (!isPracuj) {
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                try {
                    if (['image', 'media', 'font'].includes(request.resourceType())) {
                        request.abort();
                    } else {
                        request.continue();
                    }
                } catch (e) {
                    // Ignore rare "request already handled" races from Puppeteer's API
                }
            });
        }

        console.log(`🔗 Generated link: ${url}`);

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            console.error('❌ Website blocked the connection or took too long to respond.');
            return;
        }

        // Collect item links, regardless of whether it's OLX or Pracuj.pl
        const itemLinks = await page.evaluate((plat) => {
            let links = [];
            if (plat === 'OLX') {
                links = Array.from(document.querySelectorAll('a[href*="/oferta/"]')).map(a => a.href);
            } else if (plat === 'Pracuj.pl') {
                // Pracuj.pl usually has links like /praca/...
                links = Array.from(document.querySelectorAll('a[href*="/praca/"]')).map(a => a.href);
                // Filter out junk links that just point back to search/filter pages
                links = links.filter(link => !link.includes('?'));
            }
            return links;
        }, platform);

        const uniqueLinks = [...new Set(itemLinks)].slice(0, 20); // first 20 results only - change to e.g. 30 for more, but it'll take longer

        if (uniqueLinks.length === 0) {
            console.log('\n⚠️ No listings found. Either there are no results for this search, or the site\'s layout changed and the selectors need updating.');
            return;
        }

        console.log(`\n✅ Found ${uniqueLinks.length} unique listings (max 20). Starting to collect...`);

        fs.appendFileSync(OUTPUT_FILE, `\n\n=== SEARCH: ${platform} | ${category} | ${new Date().toLocaleString()} ===\nLINK: ${url}\n\n`);

        for (let i = 0; i < uniqueLinks.length; i++) {
            const link = uniqueLinks[i];
            console.log(`[${i + 1}/${uniqueLinks.length}] Analyzing: ${link}`);
            try {
                await page.goto(link, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('h1', { timeout: 4000 }).catch(() => {});

                const data = await page.evaluate((plat) => {
                    const title = document.querySelector('h1')?.innerText || 'Name not found';

                    let price = 'Not listed';
                    let description = 'Not found';
                    let actionExists = false; // OLX: "call/show number" button | Pracuj.pl: "Apply" button

                    if (plat === 'OLX') {
                        const priceBlock = document.querySelector('[data-testid="ad-price"]') || document.querySelector('h3');
                        if (priceBlock) price = priceBlock.innerText.trim();

                        const descBlock = document.querySelector('div[data-cy="ad_description"]') || document.querySelector('div[data-testid="ad_description"]');
                        if (descBlock) description = descBlock.innerText;

                        actionExists = Array.from(document.querySelectorAll('button, a')).some(btn => btn.innerText && (btn.innerText.includes('Zadzwoń') || btn.innerText.includes('Pokaż')));
                    } else if (plat === 'Pracuj.pl') {
                        const salaryBlock = document.querySelector('[data-test="text-earningAmount"]');
                        if (salaryBlock) price = salaryBlock.innerText.trim();

                        const descBlock = document.querySelector('[data-test="section-responsibilities"]') || document.querySelector('[data-test="text-description"]');
                        if (descBlock) description = descBlock.innerText;

                        // Pracuj.pl doesn't have "Zadzwoń" like OLX, only "Aplikuj" (Apply)
                        actionExists = Array.from(document.querySelectorAll('button, a')).some(btn => btn.innerText && btn.innerText.includes('Aplikuj'));
                    }

                    return { title, price, description, actionExists };
                }, platform);

                const cleanDescription = data.description.replace(/\s+/g, ' ').trim();
                const shortDescription = cleanDescription.length > 400
                    ? cleanDescription.substring(0, 400) + '...'
                    : cleanDescription;

                const actionLabel = isPracuj ? '📨 Apply button' : '📞 Phone';
                const textToSave = `📌 Name: ${data.title}\n💰 Price/Salary: ${data.price}\n${actionLabel}: ${data.actionExists ? 'Yes ✅' : 'No ❌'}\n🔗 Link: ${link}\n📝 Description: ${shortDescription}\n--------------------------------------------------\n`;

                fs.appendFileSync(OUTPUT_FILE, textToSave);

                const delay = Math.floor(Math.random() * (3000 - 1500 + 1)) + 1500;
                await new Promise(resolve => setTimeout(resolve, delay));

            } catch (error) {
                console.error(`❌ Mistake on item ${i + 1}: ${error.message}`);
                if (!browser.isConnected()) {
                    console.error('⚠️ Browser connection lost (window closed or crashed) — stopping early.');
                    break;
                }
            }
        }

        console.log(`\n🎉 Done! Results saved to ${OUTPUT_FILE}`);
    } finally {
        await browser.close().catch((e) => console.error('⚠️ Could not close browser cleanly:', e.message));
    }
}

async function runMenu() {
    try {
        console.clear();
        console.log('=============================================');
        console.log(' WORKParcer (OLX & PRACUJ.PL)');
        console.log('=============================================\n');

        const platformChoice = (await rl.question('Choose platform:\n1. OLX\n2. Pracuj.pl\n> ')).trim();
        const platform = platformChoice === '2' ? 'Pracuj.pl' : 'OLX';

        let category = 'Work';
        let categorySlug = 'praca';

        if (platform === 'OLX') {
            const catChoice = (await rl.question('\nChoose category on OLX:\n1. Work\n2. Home\n3. Electronics\n4. Vehicles\n> ')).trim();
            if (catChoice === '2') {
                category = 'Home';
                categorySlug = 'nieruchomosci';
            } else if (catChoice === '3') {
                category = 'Electronics';
                categorySlug = 'elektronika';
            } else if (catChoice === '4') {
                // Covers both cars and motorcycles/scooters - narrow it down with
                // the keyword prompt below (e.g. "samochod", "skuter", a specific model)
                category = 'Vehicles';
                categorySlug = 'motoryzacja';
            }
        }

        const cityInput = (await rl.question('\nChoose city (for example: Poznań, Warszawa, or leave empty to search all of Poland):\n> ')).trim();
        const city = cityInput ? formatForUrl(cityInput) : '';

        const keywordInput = (await rl.question('\nEnter a keyword (example: zabka, iphone 13, kawalerka):\n> ')).trim();
        const keyword = keywordInput ? formatForUrl(keywordInput) : '';

        let finalUrl = '';

        // Generating link for OLX
        if (platform === 'OLX') {
            if (city && keyword) {
                finalUrl = `https://www.olx.pl/${categorySlug}/${city}/q-${keyword}/`;
            } else if (city) {
                finalUrl = `https://www.olx.pl/${categorySlug}/${city}/`;
            } else if (keyword) {
                finalUrl = `https://www.olx.pl/${categorySlug}/q-${keyword}/`;
            } else {
                finalUrl = `https://www.olx.pl/${categorySlug}/`;
            }
        } else if (platform === 'Pracuj.pl') {
            // Link for Pracuj.pl
            if (city && keyword) {
                finalUrl = `https://www.pracuj.pl/praca/${keyword};kw/${city};wp`;
            } else if (city) {
                finalUrl = `https://www.pracuj.pl/praca/${city};wp`;
            } else if (keyword) {
                finalUrl = `https://www.pracuj.pl/praca/${keyword};kw`;
            } else {
                finalUrl = `https://www.pracuj.pl/praca/`;
            }
        }

        await startScraping(finalUrl, platform, category);
    } catch (error) {
        console.error(`\n❌ Unexpected error: ${error.message}`);
    } finally {
        rl.close();
    }
}

// Entry point
runMenu();