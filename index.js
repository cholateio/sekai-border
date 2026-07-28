// for gcp
const { createClient } = require('@supabase/supabase-js');

const URL_TOP100 = 'https://api.hisekai.org/tw/event/live/top100';
const URL_BORDER = 'https://api.hisekai.org/tw/event/live/border';

const TARGET_TOP_RANKS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
const TARGET_MID_RANKS = new Set([200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 5000, 10000]);

// headersSent guard keeps the error path from throwing a second time, which is
// what turned a response bug into a 500 on every otherwise-successful run.
function sendPlain(res, statusCode, body) {
    if (res.headersSent) return;
    res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
}

exports.runFetch = async (req, res) => {
    const now = new Date().toISOString();
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

    const CONTACT_INFO = process.env.BOT_CONTACT || 'Anonymous-User';

    const REQUEST_OPTIONS = {
        headers: {
            'User-Agent': CONTACT_INFO,
            Accept: 'application/json',
        },
    };

    async function fetchJsonWithRetry(url, retries = 3, delay = 2000) {
        for (let attempt = 1; attempt <= retries + 1; attempt++) {
            try {
                const response = await fetch(url, REQUEST_OPTIONS);
                if (!response.ok) {
                    throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
                }
                return await response.json();
            } catch (err) {
                if (attempt <= retries) {
                    console.warn(`[Network] ${url} 失敗 (嘗試 ${attempt})。`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                } else {
                    throw new Error(`[Network] ${url} 重試 ${retries} 次後徹底失敗: ${err.message}`);
                }
            }
        }
    }

    async function checkAndClearOldEvent(newEventId) {
        try {
            const { data, error } = await supabase
                .from('event_rankings')
                .select('event_id')
                .order('created_at', { ascending: false })
                .limit(1);

            if (error) throw error;
            if (!data || data.length === 0) return;

            const oldEventId = data[0].event_id;

            if (oldEventId !== newEventId) {
                console.log(`[System] New event detected (Old: ${oldEventId}, New: ${newEventId}). Clearing old data...`);
                const { error: deleteError } = await supabase.from('event_rankings').delete().neq('event_id', newEventId);
                if (deleteError) throw deleteError;
                console.log('[System] Old event data cleared successfully.');
            }
        } catch (err) {
            console.error('[System] Error checking/clearing old event:', err.message);
        }
    }

    // --- main logic ---
    try {
        const [dataTop100, dataBorder] = await Promise.all([fetchJsonWithRetry(URL_TOP100), fetchJsonWithRetry(URL_BORDER)]);

        // API returns `id` as a JSON number, but event_rankings.event_id is a text
        // column. Normalize to string here so the comparison in
        // checkAndClearOldEvent is same-type; otherwise 174 !== '174' is always
        // true and the destructive clear fires on every run.
        const eventId = dataTop100?.id != null ? String(dataTop100.id) : 'unknown_event';

        if (eventId !== 'unknown_event') {
            await checkAndClearOldEvent(eventId);
        }

        let recordsToInsert = [];

        dataTop100.player_top_100_rankings.forEach((item) => {
            if (TARGET_TOP_RANKS.has(item.rank)) {
                recordsToInsert.push({ rank: item.rank, score: item.score, event_id: eventId, created_at: now });
            }
        });

        dataBorder.player_border_rankings.forEach((item) => {
            if (TARGET_MID_RANKS.has(item.rank)) {
                recordsToInsert.push({ rank: item.rank, score: item.score, event_id: eventId, created_at: now });
            }
        });

        if (recordsToInsert.length > 0) {
            const { error } = await supabase.from('event_rankings').insert(recordsToInsert);
            if (error) throw error;
            console.log(`[System] 成功寫入 ${recordsToInsert.length} 筆資料。時間: ${now}`);
        }

        // Native ServerResponse methods, not Express's res.status().send(): the
        // bare http server below passes a raw ServerResponse, which has no
        // .status(). Express responses inherit writeHead/end, so this stays
        // correct under functions-framework too.
        sendPlain(res, 200, 'Fetch and Save Completed');
    } catch (err) {
        console.error(err.message);
        // 500 so the GCP log marks the run red
        sendPlain(res, 500, `Error: ${err.message}`);
    }
};


// [Fix for Cloud Run] 啟動一個簡單的 HTTP Server 監聽 8080 Port
const http = require('http');
const port = process.env.PORT || 8080;

const server = http.createServer(async (req, res) => {
    console.log(`[Request] 收到執行請求: ${req.method} ${req.url}`);
    try {
        // 直接呼叫你原本寫好的 runFetch 邏輯
        await exports.runFetch(req, res);
    } catch (err) {
        console.error('[Fatal Error]', err.message);
        if (!res.headersSent) {
            res.writeHead(500);
            res.end(`Internal Error: ${err.message}`);
        }
    }
});

server.listen(port, () => {
    console.log(`[System] Container 啟動成功，監聽 Port: ${port}`);
});
