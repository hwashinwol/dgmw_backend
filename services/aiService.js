require('dotenv').config();
const axios = require('axios');
const textStatistics = require('text-statistics');

const {
    OPENAI_API_KEY,
    GOOGLE_API_KEY,
    ANTHROPIC_API_KEY
} = process.env;

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GOOGLE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_API_KEY}`;
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// ─────────────────────────────
// 1️⃣ 가독성 점수
// ─────────────────────────────
function getReadableScore(text) {
    if (!text || text.trim() === '') return null;
    try {
        const stats = textStatistics(text);
        return stats.fleschKincaidReadingEase();
    } catch (error) {
        console.error("가독성 점수 계산 실패:", error);
        return null;
    }
}

// ─────────────────────────────
// 2️⃣ Spectrum 점수 (GPT-4o 평가)
// ─────────────────────────────
async function getSpectrumScore(originalText, translatedText) {
    if (!originalText || !translatedText) return null;

    const prompt = `
You are an evaluator for a translation service.
Compare the [Original Text] and [Translated Text].
Give a JSON only: {"spectrum_score": X} where X is 1.0 (literal) ~ 10.0 (free translation).

[Original Text]:
${originalText}

[Translated Text]:
${translatedText}
`;

    try {
        const response = await axios.post(OPENAI_ENDPOINT, {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: "json_object" }
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });

        const raw = response.data.choices[0].message.content;
        try {
            const json = JSON.parse(raw);
            return json.spectrum_score || null;
        } catch {
            console.error("JSON 파싱 실패:", raw);
            return null;
        }
    } catch (error) {
        console.error("Spectrum Score 호출 실패:", error.response?.data || error.message);
        return null;
    }
}

// ─────────────────────────────
// 3️⃣ OpenAI (GPT)
// ─────────────────────────────
async function callOpenAI(model, textToTranslate) {
    try {
        const response = await axios.post(OPENAI_ENDPOINT, {
            model,
            messages: [
                { role: 'system', content: 'You are a professional translator. Translate the following Korean text to English.' },
                { role: 'user', content: textToTranslate }
            ]
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });

        return {
            model_name: model,
            translated_text: response.data.choices[0].message.content.trim()
        };
    } catch (error) {
        console.error(`${model} 호출 실패:`, error.response?.data || error.message);
        return { model_name: model, translated_text: null, error: error.message };
    }
}

// ─────────────────────────────
// 4️⃣ Gemini (Google)
// ─────────────────────────────
async function callGoogle(textToTranslate) {
    try {
        const response = await axios.post(GOOGLE_ENDPOINT, { 
            contents: [
                {
                    parts : [{text: `Translate the following Korean text to English:\n${textToTranslate}`}]
                }
            ]
        }, {
            headers: {
                "Content-Type": "application/json"
            }
        });

        const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
        
        if(!rawText) {
            throw new Error('Gemini가 빈 응답을 반환했습니다.')
        }

        let translated_text = rawText;

        if (translated_text.startsWith('(') && translated_text.endsWith(')')) {
            const innerMatch = translated_text.match(/[\*"](.*?)[\"*]/);
            if (innerMatch && innerMatch[1]) {
                translated_text = innerMatch[1].trim();
            } else {
                translated_text = translated_text.substring(1, translated_text.length - 1).trim();
            }
        }

        const match = translated_text.match(/[\*"](.*?)[\"*]/);
        if (match && match[1] && match[1].length > 0) {
            translated_text = match[1].trim();
        } else {
            const firstLineBreak = translated_text.indexOf('\n');
            if (firstLineBreak > -1) {
                translated_text = translated_text.substring(firstLineBreak).trim();
            }
        }
        
        return {
            model_name: "Gemini 2.5 Flash", 
            translated_text: translated_text
        };
    } catch (error) {
        console.error("Gemini API 호출 실패:", error.response?.data || error.message);
        return { model_name: "Gemini 2.5 Flash", translated_text: null, error: error.message }; 
    }
}

// ─────────────────────────────
// 5️⃣ Claude (Anthropic)
// ─────────────────────────────
async function callAnthropic(textToTranslate) {
    try {
        const response = await axios.post(ANTHROPIC_ENDPOINT, {
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 1024,
            system: "You are a professional translator. Translate the following Korean text to English.",
            messages: [
                { role: "user", content: textToTranslate }
            ]
        }, {
            headers: {
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json"
            }
        });

        const text = response.data?.content?.[0]?.text?.trim() || null;
        return { model_name: "Claude Sonnet 4.5", translated_text: text };
    } catch (error) {
        console.error("Claude API 호출 실패:", error.response?.data || error.message);
        return { model_name: "Claude Sonnet 4.5", translated_text: null, error: error.message };
    }
}

// ─────────────────────────────
// 6️⃣ 전체 실행
// ─────────────────────────────
async function runAnalysis(textToTranslate, userStatus = 'free') {
    console.log(`[AI 서비스] 번역 시작... (등급: ${userStatus})`);

    const translationPromises =
        userStatus === 'paid'
            ? [callOpenAI('gpt-4o', textToTranslate), callGoogle(textToTranslate), callAnthropic(textToTranslate)]
            : [callOpenAI('gpt-3.5-turbo', textToTranslate)];

    const initialResults = await Promise.all(translationPromises);
    let finalResults = [];

    for (const res of initialResults) {
        if (res.error) {
            finalResults.push({ ...res, readable_score: null, spectrum_score: null });
            continue;
        }
        finalResults.push({
            ...res,
            readable_score: getReadableScore(res.translated_text),
            spectrum_score: null
        });
    }

    if (userStatus === 'paid') {
        const spectrumScores = await Promise.all(
            finalResults.map(res =>
                res.translated_text ? getSpectrumScore(textToTranslate, res.translated_text) : Promise.resolve(null)
            )
        );
        finalResults = finalResults.map((res, i) => ({ ...res, spectrum_score: spectrumScores[i] }));
    }

    console.log(`[AI 서비스] 완료. 총 ${finalResults.length}개 결과 반환.`);
    return finalResults;
}

module.exports = { runAnalysis };