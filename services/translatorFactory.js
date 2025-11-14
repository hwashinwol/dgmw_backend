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

const domainRulesMap = {
        "engineering": "In engineering domain, prioritize technical accuracy and precise terminology. Literal translation is generally preferred for clarity.",
        "social_science": "In social sciences, maintain conceptual accuracy, but allow natural phrasing for readability.",
        "art": "In arts domain, prioritize expressive, natural translation. Free translation is acceptable to convey nuance.",
        "medical": "In medical domain, prioritize accuracy and safety. Literal translation is strongly preferred.",
        "law": "In legal domain, maintain strict legal terminology. Literal translation is required.",
        "nature_science": "In natural sciences, technical accuracy is critical. Literal translation is generally preferred.",
        "humanities": "In humanities, natural and fluent translation is important. Free translation is acceptable to convey meaning and style.",
        "literature": "In literary works (novels/poems/plays), prioritize capturing the original's artistic style, tone, and emotional nuance. Natural, fluent, and expressive translation is paramount. Free translation and the creative adaptation of idioms are essential to convey the cultural context and authorial intent, even if it deviates from a literal translation."
    };

// API Endpoints
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GOOGLE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_API_KEY}`;
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// 3️⃣ OpenAI (GPT)
async function callOpenAI(model, textToTranslate, selected_domain) { // ⭐️ selected_domain 인자 받음
    try {
        const domainRule = domainRulesMap[selected_domain];
        let system_prompt = 'You are a professional translator. Detect the language of the input text. If it is Korean, translate it to English. If it is English, translate it to Korean.';
        if (domainRule) {
            system_prompt += ` You are an expert translator specializing in the **${domainRule}** field. Pay close attention to the specialized terminology of this field.`;
        }

        const response = await axios.post(OPENAI_ENDPOINT, {
            model,
            messages: [
                { role: 'system', content: system_prompt }, 
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
async function callGoogle(textToTranslate, selected_domain) { // ⭐️ selected_domain 인자 받음
    try {
        const domainRule = domainRulesMap[selected_domain];
        let base_prompt = 'Detect the language of the following text. If it is Korean, translate it to English. If it is English, translate it to Korean.';
        if (domainRule) {
            base_prompt += ` You are an expert translator specializing in the **${domainRule}** field. Pay close attention to the specialized terminology of this field.`;
        }

        const response = await axios.post(GOOGLE_ENDPOINT, { 
            contents: [
                {
                    parts : [{text: `${base_prompt}\n\n${textToTranslate}`}]
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

// Claude Sonnet 4.5
async function callAnthropic(textToTranslate, selected_domain) { // ⭐️ selected_domain 인자 받음
    try {
        if (!textToTranslate || !textToTranslate.trim()) {
            return { 
                model_name: "Claude Sonnet 4.5", 
                translated_text: null, 
                error: "입력 텍스트가 비어 있습니다." 
            };
        }

        const domainRule = domainRulesMap[selected_domain];
        let system_prompt = 'You are a professional translator. Detect the language of the input text. If it is Korean, translate it to English. If it is English, translate it to Korean.';
    
        if (domainRule) {
            system_prompt += ` You are an expert translator specializing in the **${domainRule}** field. Pay close attention to the specialized terminology of this field.`;
        }

        const response = await axios.post(ANTHROPIC_ENDPOINT, {
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 1024,
            system: system_prompt, 
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

        // 실제 Claude API 반환 구조에 맞게 텍스트 추출
        const text = response.data?.content?.[0]?.text?.trim() || null;

        return { 
            model_name: "Claude Sonnet 4.5", 
            translated_text: text 
        };

    } catch (error) {
        logger.error("Claude API 호출 실패:", error.response?.data || error.message);
        return { 
            model_name: "Claude Sonnet 4.5", 
            translated_text: null, 
            error: error.message 
        };
    }
}

// Google Translate (Standard NMT)
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

// async function callPapagoTranslate(text) {
//     const model_name = "Papago (NCP)";
    
//     if (!PAPAGO_CLIENT_ID || !PAPAGO_CLIENT_SECRET) {
//         logger.warn('[AI Service] Papago API 키가 .env에 설정되지 않았습니다. Papago 호출을 건너뜁니다.');
//         return { model_name, error: "API 키가 설정되지 않았습니다." };
//     }

//     const headers = {
//         'X-NCP-APIGW-API-KEY-ID':PAPAGO_CLIENT_ID,
//         'X-NCP-APIGW-API-KEY':PAPAGO_CLIENT_SECRET,
//         'Content-Type': 'application/json'
//     };
    
//     let sourceLang;
//     let targetLang;

//     try {
//         // 1. [신규] Papago 언어 감지 API 호출
//         const detectResponse = await axios.post(
//             PAPAGO_DETECT_ENDPOINT, 
//             { query: text.substring(0, 1000) }, // (언어 감지는 1000자면 충분)
//             { headers }
//         );
        
//         const detectedLang = detectResponse.data?.langCode;

//         if (detectedLang === 'ko') {
//             sourceLang = 'ko';
//             targetLang = 'en';
//         } else if (detectedLang === 'en') {
//             sourceLang = 'en';
//             targetLang = 'ko';
//         } else {
//             // (기타 언어는 en -> ko로 강제)
//             logger.warn(`[Papago] 감지된 언어(${detectedLang})가 en/ko가 아니므로, en -> ko로 강제합니다.`);
//             sourceLang = 'en';
//             targetLang = 'ko';
//         }

//     } catch (error) {
//         logger.error('[AI Service] Papago 언어 감지 실패:', { 
//             status: error.response?.status, 
//             data: error.response?.data 
//         });
//         console.log(error);
//         // (감지 실패 시 기본값 ko -> en)
//         sourceLang = 'ko';
//         targetLang = 'en';
//     }

//     // 2. [수정] Papago 번역 API 호출 (감지된 언어 적용)
//     const body = {
//         source: sourceLang, // ⭐️ [수정] 'ko' -> sourceLang
//         target: targetLang, // ⭐️ [수정] 'en' -> targetLang
//         text: text
//     };

//     try {
//         const response = await axios.post(PAPAGO_ENDPOINT, body, { headers });
        
//         if (response.data && response.data.message && response.data.message.result) {
//             const translatedText = response.data.message.result.translatedText;
//             return {
//                 model_name: model_name,
//                 translated_text: translatedText,
//                 complexity_score: null, 
//                 spectrum_score: null
//             };
//         } else {
//             throw new Error('Papago API 응답 형식이 올바르지 않습니다.');
//         }
//     } catch (error) {
//         logger.error('[AI Service] Papago API (번역) 호출 실패:', { 
//             status: error.response?.status, 
//             data: error.response?.data 
//         });
//         console.log(error);
//         return { model_name: model_name, error: "API (번역) 호출 실패" };
//     }
// }

module.exports = {
    callOpenAI,
    callGoogle,
    callAnthropic,
    callGoogleTranslate
};
