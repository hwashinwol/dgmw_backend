// 2. 번역 API 호출부 분리 
const axios = require('axios');
const { Translate } = require("@google-cloud/translate").v2;

const {
    OPENAI_API_KEY,
    GOOGLE_API_KEY,
    ANTHROPIC_API_KEY
} = process.env;

// Google NMT (Free tier)
const googleTranslate = new Translate({
    key : GOOGLE_API_KEY
});

const logger = require('../utils/logger');

// API Endpoints
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GOOGLE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_API_KEY}`;
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// 3️⃣ OpenAI (GPT)
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
        logger.error(`${model} 호출 실패:`, error.response?.data || error.message);
        return { model_name: model, translated_text: null, error: error.message };
    }
}

// 4️⃣ Gemini (Google)
async function callGoogle(textToTranslate) {
    try {
        const response = await axios.post(GOOGLE_ENDPOINT, { 
            contents: [
                {
                    parts : [{text: `Detect the language of the following text. If it is Korean, translate it to English. If it is English, translate it to Korean.\n\n${textToTranslate}`}]
                }
            ]
        }, {
            headers: { "Content-Type": "application/json" }
        });

        const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
        
        if(!rawText) {
            throw new Error('Gemini가 빈 응답을 반환했습니다.')
        }

        // --- Gemini 응답 파싱 로직 ---
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
        // --- 파싱 종료 ---
        
        return {
            model_name: "Gemini 2.5 Flash", 
            translated_text: translated_text
        };
    } catch (error) {
        logger.error("Gemini API 호출 실패:", error.response?.data || error.message);
        return { model_name: "Gemini 2.5 Flash", translated_text: null, error: error.message }; 
    }
}

// 5️⃣ Claude (Anthropic)
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
        logger.error("Claude API 호출 실패:", error.response?.data || error.message);
        return { model_name: "Claude Sonnet 4.5", translated_text: null, error: error.message };
    }
}

// 6️⃣ Google Translate (Standard NMT)
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
            logger.warn(`[Google Translate] 감지된 언어(${detectedLang})가 en/ko가 아니므로, en -> ko로 강제합니다.`);
            targetLang = 'ko'
        }

        let [translation] = await googleTranslate.translate(textToTranslate, targetLang);
        return {
            model_name: model_name,
            translated_text: translation
        };
    } catch (error) {
        logger.error("Google Translate API 호출 실패:", error.message);
        return { model_name: model_name, translated_text: null, error: error.message };
    }
}

module.exports = {
    callOpenAI,
    callGoogle,
    callAnthropic,
    callGoogleTranslate
};
