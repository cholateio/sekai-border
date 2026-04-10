// for gcp
const { createClient } = require('@supabase/supabase-js');

const URL_TOP100 = 'https://api.hisekai.org/tw/event/live/top100';
const URL_BORDER = 'https://api.hisekai.org/tw/event/live/border';

const TARGET_TOP_RANKS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
const TARGET_MID_RANKS = new Set([200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 5000, 10000]);

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

        const eventId = dataTop100?.id || 'unknown_event';

        if (eventId !== 'unknown_event') {
            await checkAndClearOldEvent(eventId);
        }

        let recordsToInsert = [];

        (dataTop100?.player_top_100_rankings || []).forEach((item) => {
            if (TARGET_TOP_RANKS.has(item.rank)) {
                recordsToInsert.push({ rank: item.rank, score: item.score, event_id: eventId, created_at: now });
            }
        });

        (dataBorder?.player_border_rankings || []).forEach((item) => {
            if (TARGET_MID_RANKS.has(item.rank)) {
                recordsToInsert.push({ rank: item.rank, score: item.score, event_id: eventId, created_at: now });
            }
        });

        if (recordsToInsert.length > 0) {
            const { error } = await supabase.from('event_rankings').insert(recordsToInsert);
            if (error) throw error;
            console.log(`[System] 成功寫入 ${recordsToInsert.length} 筆資料。時間: ${now}`);
        }

        // [Error Handling] 執行完畢，一定要回傳 200 給 GCP，告訴它「我跑完了，可以關閉連線了」
        res.status(200).send('Fetch and Save Completed');
    } catch (err) {
        console.error(err.message);
        // [Error Handling] 發生錯誤也要回傳 500，這樣 GCP Log 才會標示為紅色錯誤
        res.status(500).send(`Error: ${err.message}`);
    }
};
