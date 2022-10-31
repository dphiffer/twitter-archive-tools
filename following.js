(async () => {
	const fs = require('fs');
	const path = require('path');
	const puppeteer = require('puppeteer');
	const csv = require('fast-csv');
	const glob = require('glob');
	const mkdirp = require('mkdirp');
	const AdmZip = require('adm-zip');
	const ProgressBar = require('progress');

	let archiveFiles = glob.sync(`${__dirname}/archives/twitter-*.zip`);
	if (archiveFiles.length == 0) {
		console.error('Not found: ./archives/twitter-*.zip');
		process.exit(1);
	}
	archiveFiles.sort();
	var zipFile = archiveFiles.pop();
	console.log(`Reading from ./archives/${path.basename(zipFile)}`);

	let zip = new AdmZip(zipFile);
	let entry = zip.getEntry('data/following.js');
	let jsData = entry.getData().toString();
	let jsonData = jsData.replace('window.YTD.following.part0 = ', '');
	let data = JSON.parse(jsonData);

	let progress = new ProgressBar('[:bar] :current/:total', {
		complete: '=',
		incomplete: ' ',
		width: 45,
		total: data.length
	});

	mkdirp.sync(`${__dirname}/data/accounts`);

	console.log('Writing to ./data/following.csv');
	let csvPath = `${__dirname}/data/following.csv`;
	let csvFile = fs.createWriteStream(csvPath);
	let csvStream = csv.format({
		headers: true
	});
	csvStream.pipe(csvFile).on('end', () => process.exit());

	var browser, page;
	var loaded = 0, skipped = 0;
	var errorLog;

	async function setupPage() {
		if (browser) {
			await browser.close();
		}
		browser = await puppeteer.launch();
		page = await browser.newPage();
		page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36');
		page.setViewport({
			width: 960,
			height: 768
		});
	}

	async function loadAccount(id) {
		let account;
		let cachePath = getCachePath(id);
		if (fs.existsSync(cachePath)) {
			account = loadAccountFromCache(id);
		} else {
			account = await loadAccountFromTwitter(id);
			saveAccountToCache(id, account);
		}
		return account;
	}

	function getCachePath(id) {
		return `${__dirname}/data/accounts/${id}.json`;
	}

	function loadAccountFromCache(id) {
		let cachePath = getCachePath(id);
		let json = fs.readFileSync(cachePath, 'utf8');
		return JSON.parse(json);
	}

	function saveAccountToCache(id, account) {
		if (!account) {
			return;
		}
		let cachePath = getCachePath(id);
		let json = JSON.stringify(account);
		fs.writeFileSync(cachePath, json, 'utf8');
	}

	async function loadAccountFromTwitter(id) {
		try {
			let accountUrl = `https://twitter.com/intent/user?user_id=${id}`;
			await page.goto(accountUrl);
			await page.waitForSelector('img[alt="Opens profile photo');

			let title = await page.evaluate(() => document.title);
			let match = title.match(/^(.+) \(@([^)+]+)\) \/ Twitter$/);
			if (! match) {
				throw new Error(`Could not decipher name/username from ${title}.`);
			}
			let name = match[1];
			let username = match[2];

			let imageEl = await page.$('img[alt="Opens profile photo"]');
			let image = await page.evaluate(el => el.src, imageEl);

			let description = '';
			let descriptionEl = await page.$('div[data-testid="UserDescription"]');
			if (descriptionEl) {
				description = await page.evaluate(el => el.innerText, descriptionEl);
				description = description.replace(/\n/g, '');
			}

			let url = '';
			let urlEl = await page.$('a[data-testid="UserUrl"]');
			if (urlEl) {
				url = await page.evaluate(el => el.href, urlEl);
			}

			let location = '';
			let locationEl = await page.$('span[data-testid="UserLocation"]');
			if (locationEl) {
				location = await page.evaluate(el => el.innerText, locationEl);
			}

			let joined = '';
			let joinedEl = await page.$('span[data-testid="UserJoinDate"]');
			if (joinedEl) {
				joined = await page.evaluate(el => el.innerText, joinedEl);
			}

			// After 250 loads we need to re-setup Puppeteer for unknown
			// reasons. It could be that we get throttled at that point.
			loaded++;
			if (loaded % 250 == 0) {
				await setupPage();
			}

			return {
				id: id,
				username: username,
				name: name,
				image: image, // profile image URL
				description: description,
				location: location,
				url: url, // t.co redirect URL to profile link
				joined: joined
			};
		} catch (err) {
			// await page.screenshot({
			// 	path: `${__dirname}/error.png`
			// });
			if (!errorLog) {
				errorLog = fs.createWriteStream(`${__dirname}/error.log`);
			}
			errorLog.write(`skipped account ${id}\n`);
			skipped++;
			await setupPage();
			return false;
		}
	}

	await setupPage();
	for (let account of data) {
		let row = await loadAccount(account.following.accountId);
		csvStream.write(row);
		progress.tick(1);
	}
	if (skipped > 0) {
		errorLog.end();
		console.log(`Skipped ${skipped} accounts due to errors (see: error.log)`);
	}
	await browser.close();
	csvStream.end();

})();
