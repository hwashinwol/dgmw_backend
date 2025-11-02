require('dotenv').config();
const axios = require('axios');
const {Translate} = require("@google-cloud/translate").v2;

const {
    OPENAI_API_KEY,
    GOOGLE_API_KEY,
    ANTHROPIC_API_KEY
} = process.env;

const googleTranslate = new Translate({
    key : GOOGLE_API_KEY
});

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GOOGLE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_API_KEY}`;
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// ─────────────────────────────
// 1️⃣ 가독성 점수 (자체 구현)
// ─────────────────────────────
function getComplexityScore(text) {
    if (!text || text.trim() === '') return null;
    
    try {
        const cleanedText = text.replace(/[^\p{L}\p{N}\s]/gu, '');
        const words = cleanedText.split(/\s+/).filter(word => word.length > 0);
        const wordCount = words.length;
        const charCount = words.reduce((acc, word) => acc + word.length, 0);

        if (wordCount === 0 || charCount === 0) {
            return 0; 
        }

        const aclw = charCount / wordCount;
        
        return Math.round(aclw * 100) / 100;

    } catch (error) {
        console.error("복잡성 점수 계산 실패:", error);
        return null;
    }
}

// ─────────────────────────────
// 2️⃣ Spectrum 점수 (GPT-4o 평가)
// ─────────────────────────────
async function getSpectrumScore(originalText, translatedText, selected_domain) {
    if (!originalText || !translatedText) return null;

    let domainInstruction = "";
    if (selected_domain && selected_domain.toLowerCase() !== 'null' && selected_domain.trim() !== '') {
        domainInstruction = `
The text is from the [Domain: ${selected_domain}]. 
Your evaluation must be based on the translation conventions of this specific field.
(e.g., law/medical fields often require literal translation, while art/humanities fields may prefer free translation.)
`;
    } else {
        domainInstruction = "The text is general. Evaluate it based on standard translation conventions.";
    }

    const prompt = `
You are an evaluator for a translation service.
${domainInstruction}

Analyze the style of the [Translated Text] compared to the [Original Text].
Is the translation a "Literal Translation" (strict, word-for-word, prioritizes source structure) or a "Free Translation" (creative, prioritizes target nuance and meaning)?

Respond ONLY with a JSON object in the format: {"spectrum_score": X}
Where X is a single number from 1.0 to 10.0.
1.0 = 100% Literal (원문에 충실한 직역, [Domain] 맥락 고려)
10.0 = 100% Free (의미 중심의 자연스러운 의역, [Domain] 맥락 고려)

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
                { role: 'system', content: 'You are a professional translator. Detect the language of the input text. If it is Korean, translate it to English. If it is English, translate it to Korean.' },
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
                    parts : [{text: `Detect the language of the following text. If it is Korean, translate it to English. If it is English, translate it to Korean.\n\n${textToTranslate}`}]
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
            system: "You are a professional translator. Detect the language of the input text. If it is Korean, translate it to English. If it is English, translate it to Korean.",
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
// 6️⃣ Google Translate (Standard NMT)
// ─────────────────────────────
async function callGoogleTranslate(textToTranslate){
    const model_name = "Google Translate(NMT)"
    try {
        let [detections] = await googleTranslate.detect(textToTranslate);
        const detectedLang = detections.language;

        let targetLang;
        if (detectedLang === 'ko') {
            targetLang = 'en';
        } else if (detectedLang === 'en') {
            targetLang = 'ko';
        } else {
            // 지원하지 않는 언어 (또는 감지 실패 시 ko로 강제)
            console.warn(`[Google Translate] 감지된 언어(${detectedLang})가 en/ko가 아니므로, en -> ko로 강제합니다.`);
            targetLang = 'ko'
        }

        let [translation] = await googleTranslate.translate(textToTranslate, targetLang);
        return {
            model_name: model_name,
            translated_text: translation
        };
    } catch (error) {
        console.error("Google Translate API 호출 실패:", error.message);
        return { model_name: model_name, translated_text: null, error: error.message };
    }
}

// ─────────────────────────────
// 6️⃣ 전체 실행
// ─────────────────────────────
async function runAnalysis(textToTranslate, userStatus = 'free', selected_domain = 'NULL') {
    console.log(`[AI 서비스] 번역 시작... (등급: ${userStatus}, 분야: ${selected_domain})`);

    const translationPromises =
        userStatus === 'paid'
            ? [
                callOpenAI('gpt-4o', textToTranslate), 
                callGoogle(textToTranslate), 
                callAnthropic(textToTranslate)
            ]
            : [
                callOpenAI('gpt-3.5-turbo', textToTranslate),
                callGoogleTranslate(textToTranslate)
            ];

    const initialResults = await Promise.all(translationPromises);
    let finalResults = [];

    for (const res of initialResults) {
        if (res.error) {
            finalResults.push({ ...res, complexity_score: null, spectrum_score: null });
            continue;
        }
        finalResults.push({
            ...res,
            complexity_score: getComplexityScore(res.translated_text),
            spectrum_score: null
        });
    }

    if (userStatus === 'paid') {
        const spectrumScores = await Promise.all(
            finalResults.map(res =>
                res.translated_text 
                ? getSpectrumScore(textToTranslate, res.translated_text, selected_domain) 
                : Promise.resolve(null)
            )
        );
        finalResults = finalResults.map((res, i) => ({ ...res, spectrum_score: spectrumScores[i] }));
    }

    console.log(`[AI 서비스] 완료. 총 ${finalResults.length}개 결과 반환.`);
    return finalResults;
}

module.exports = { runAnalysis };