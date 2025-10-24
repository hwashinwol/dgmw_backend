require('dotenv').config();
const axios = require('axios');
const textStatistics = require('text-statistics');

// 안발급받았지만 임시 -> 발급받은건 .env 파일
const {
    OPENAI_API_KEY,
    GOOGLE_API_KEY,
    ANTHROPIC_API_KEY,
    DGMW_MT_API_URL,
    DGMW_MT_API_KEY
} = process.env;

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
// Gemini 1.5 Pro 모델 엔드포인트
const GOOGLE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GOOGLE_API_KEY}`;
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// 가독성 점수
function getReadableScore(text) {
    if (!text || text.trim() === '') {
        return null;
    }
    try {
        // text-statistics 라이브러리 사용
        const stats = textStatistics(text);
        // Flesch-Kincaid 점수 반환 (높을수록 읽기 쉬움)
        return stats.fleschKincaidReadingEase();
    } catch (error) {
        console.error("가독성 점수 계산 실패:", error);
        return null;
    }
}

// 스펙트럼 점수
/**
 * GPT-4o를 '평가자'로 사용하여 직역/의역 점수를 매깁니다.
 * @param {string} originalText - 원본 텍스트
 * @param {string} translatedText - 번역된 텍스트
 * @returns {Promise<number|null>} 1.0(직역) ~ 10.0(의역) 사이의 점수
 */

async function getSpectrumScore(originalText, translatedText) {
    if (!originalText || !translatedText) return null;
    
    const prompt = `
        You are an evaluator for a translation service.
        Analyze the following translation based on its style.
        Compare the [Original Text] with the [Translated Text].
        Determine if the translation is a "Literal Translation" (strict, word-for-word, prioritizes source structure) or a "Free Translation" (creative, prioritizes target nuance, meaning-based).
        
        Respond ONLY with a JSON object in the format: {"spectrum_score": X}
        Where X is a single number from 1.0 to 10.0.
        1.0 = 100% Literal Translation (직역)
        10.0 = 100% Free Translation (의역)

        [Original Text]:
        ${originalText}

        [Translated Text]:
        ${translatedText}
    `;

    try {
        const response = await axios.post(OPENAI_ENDPOINT, {
            model: 'gpt-4o', // GPT-4o를 '평가자'로 사용
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: "json_object" } // JSON 응답 강제
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
        });

        const jsonResponse = JSON.parse(response.data.choices[0].message.content);
        return jsonResponse.spectrum_score || null;

    } catch (error) {
        console.error("Spectrum Score API 호출 실패:", error.response ? error.response.data : error.message);
        return null;
    }
}

// 개별 AI 모델 호출
async function callOpenAI(model, textToTranslate) {
    try {
        const response = await axios.post(OPENAI_ENDPOINT, {
            model: model,
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
        console.error(`${model} API 호출 실패:`, error.message);
        return { model_name: model, translated_text: null, error: error.message };
    }
}

async function callGoogle(textToTranslate) {
    try {
        const response = await axios.post(GOOGLE_ENDPOINT, {
            contents: [{
                parts: [{
                    text: `Translate the following Korean text to English: ${textToTranslate}`
                }]
            }]
        });
        return {
            model_name: "Gemini 1.5 Pro",
            translated_text: response.data.candidates[0].content.parts[0].text.trim()
        };
    } catch (error) {
        console.error(`Gemini API 호출 실패:`, error.message);
        return { model_name: "Gemini 1.5 Pro", translated_text: null, error: error.message };
    }
}

async function callAnthropic(textToTranslate) {
    try {
        const response = await axios.post(ANTHROPIC_ENDPOINT, {
            model: "claude-3-opus-20240229",
            max_tokens: 2048,
            system: "You are a professional translator. Translate the following Korean text to English.",
            messages: [{ "role": "user", "content": textToTranslate }]
        }, {
            headers: {
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json'
            }
        });
        return {
            model_name: "Claude 3 Opus",
            translated_text: response.data.content[0].text.trim()
        };
    } catch (error) {
        console.error(`Claude API 호출 실패:`, error.message);
        return { model_name: "Claude 3 Opus", translated_text: null, error: error.message };
    }
}

async function callDGMW(textToTranslate) {
    try {
        // PM님의 DGMW-MT API 스펙에 맞게 (body, headers) 수정 필요
        const response = await axios.post(DGMW_MT_API_URL, {
            text: textToTranslate
        }, {
            headers: { 'Authorization': `Bearer ${DGMW_MT_API_KEY}` }
        });
        return {
            model_name: "DGMW-MT",
            translated_text: response.data.translated_text // (응답 스펙에 맞게 수정)
        };
    } catch (error) {
        console.error(`DGMW-MT API 호출 실패:`, error.message);
        return { model_name: "DGMW-MT", translated_text: null, error: error.message };
    }
}

// 메인 분석 함수
/**
 * @param {string} textToTranslate
 * @param {string} userStatus
 * @returns {Promise<Array<object>>}
 */
async function runAnalysis(textToTranslate, userStatus = 'free') {
    console.log(`[AI 서비스] "${textToTranslate.substring(0, 20)}..." 실제 번역 시작... (등급: ${userStatus})`);
    
    let translationPromises = [];

    if (userStatus === 'paid') {
        translationPromises = [
            callOpenAI('gpt-4o', textToTranslate),
            callGoogle(textToTranslate),
            callAnthropic(textToTranslate)
        ];
    } else { // 'free'
        translationPromises = [
            callDGMW(textToTranslate),
            callOpenAI('gpt-3.5-turbo', textToTranslate)
        ];
    }

    // [1단계] 모든 번역 API 병렬 호출
    const initialResults = await Promise.all(translationPromises);

    let finalResults = [];

    // [2단계] 가독성 점수 계산 (모든 등급 공통)
    for (const res of initialResults) {
        if (res.error) {
            // API 호출 실패 시
            finalResults.push({
                model_name: res.model_name,
                translated_text: null,
                readable_score: null,  
                spectrum_score: null,
                error: res.error
            });
            continue;
        }

        const readable_score = getReadableScore(res.translated_text);
        finalResults.push({
            ...res,
            readable_score: readable_score, 
            spectrum_score: null // (spectrum_score는 유료 등급에서만 별도 계산)
        });
    }

    // [3단계] Spectrum 점수 계산 (Paid 등급만)
    if (userStatus === 'paid') {
        // spectrum_score 계산도 병렬로 진행
        const spectrumPromises = finalResults.map(res => {
            if (res.translated_text) {
                // (원본 텍스트)와 (번역된 텍스트)를 평가자에게 전달
                return getSpectrumScore(textToTranslate, res.translated_text);
            }
            return Promise.resolve(null);
        });

        const spectrumScores = await Promise.all(spectrumPromises);

        // 최종 결과에 spectrum 점수 병합
        finalResults = finalResults.map((res, index) => ({
            ...res,
            spectrum_score: spectrumScores[index]
        }));
    }
    
    console.log(`[AI 서비스] 번역 및 분석 완료. ${finalResults.length}개 결과 반환.`);
    return finalResults;
}

// 함수 내보내기
module.exports = {runAnalysis};