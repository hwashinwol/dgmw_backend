// 1. 점수 계산 로직 분리 
const axios = require('axios');
const { OPENAI_API_KEY } = process.env;
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const logger = require('../utils/logger');

/**
 * 1. 복잡성 점수 (ACLW)
 * @param {string} text - 번역된 텍스트
 * @returns {number | null} 어절당 평균 글자 수 (낮을수록 간결)
 */
function getComplexityScore(text) {
    if (!text || !text.trim()) return null;
    try {
        // 1. 구두점 제거
        const cleanedText = text.replace(/[^\p{L}\p{N}\s]/gu, '');
        
        // 2. 어절 분리
        const words = cleanedText.split(/\s+/).filter(Boolean);
        const wordCount = words.length;

        // 3. 띄어쓰기를 제외한 '순수 글자 수' 계산
        const charCount = words.reduce((acc, word) => acc + word.length, 0);

        if (wordCount === 0 || charCount === 0) {
            return 0;
        }

        // 4. 어절당 평균 글자 수 (ACLW)
        const aclw = charCount / wordCount;
        
        return Math.round(aclw * 100) / 100;

    } catch (error) {
        logger.error("ComplexityScore 계산 실패:", { 
            message: error.message, 
            stack: error.stack,
            text: text 
        });
        return null;
    }
}

// ─────────────────────────────
// 2️⃣ Spectrum 점수 (Batch) (⭐️ 신규 추가 - 비용 절감)
// ─────────────────────────────
/**
 * 3개의 번역 결과를 GPT-4o에 한 번에 보내어 평가받습니다.
 * @param {string} originalText 원본 텍스트
 * @param {Array<Object>} translations - 번역 결과 객체 배열. 
 * (e.g., [{ model_name: "gpt-4o", translated_text: "..." }, ...])
 * @param {string} selected_domain - 선택된 전문 분야
 * @returns {Promise<Array<Object>>} - e.g., [{ model_name: "gpt-4o", spectrum_score: 2.5 }, ...]
 */
async function getSpectrumScores_Batch(originalText, translations, selected_domain) {
    if (!originalText || !translations || translations.length === 0) return [];

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

    // [Translations] 블록을 동적으로 생성
    const translationsBlock = translations.map(t => `
---
[Model: ${t.model_name}]
${t.translated_text}
---
`).join('\n');

    const prompt = `
You are an evaluator for a translation service.
${domainInstruction}

Analyze the style of the [Translations] provided below, compared to the [Original Text].
Is the translation a "Literal Translation" (strict, word-for-word) or a "Free Translation" (creative, nuance-focused)?

Score each translation from 1.0 to 10.0.
1.0 = 100% Literal (직역)
10.0 = 100% Free (의역)

[Original Text]:
${originalText}

[Translations]:
${translationsBlock}

Respond ONLY with a single JSON object in the format:
{
  "scores": [
    { "model_name": "model_name_here", "spectrum_score": X.X },
    { "model_name": "model_name_here", "spectrum_score": Y.Y },
    { "model_name": "model_name_here", "spectrum_score": Z.Z }
  ]
}
Ensure 'model_name' matches the models provided in the [Translations] block exactly.
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
            // "scores" 키가 존재하고, 배열인지 확인
            if (json.scores && Array.isArray(json.scores)) {
                return json.scores; // (e.g., [{ model_name: "gpt-4o", spectrum_score: 2.5 }, ...])
            } else {
                throw new Error("응답 JSON 포맷이 'scores' 배열을 포함하지 않습니다.");
            }
        } catch (parseError) {
            logger.error("Spectrum Score (Batch) JSON 파싱 실패:", { 
                rawText: raw, 
                message: parseError.message, 
                stack: parseError.stack 
            });
            return [];
        }
    } catch (apiError) {
        logger.error("Spectrum Score (Batch) API 호출 실패:", { 
            message: apiError.response?.data || apiError.message,
            stack: apiError.stack
        });
        return [];
    }
}

// ─────────────────────────────
// 3️⃣ Spectrum 점수 (개별) (@deprecated - 비용 문제)
// ─────────────────────────────
/**
 * @deprecated - 비용 문제로 'getSpectrumScores_Batch' 사용을 권고합니다.
 */
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
        } catch (parseError) {
            logger.error("Spectrum Score (개별) JSON 파싱 실패:", { 
                rawText: raw, 
                message: parseError.message, 
                stack: parseError.stack 
            });
            return null;
        }
    } catch (apiError) {
        logger.error("Spectrum Score (개별) API 호출 실패:", { 
            message: apiError.response?.data || apiError.message,
            stack: apiError.stack
        });
        return null;
    }
}


module.exports = {
    getComplexityScore,
    getSpectrumScores_Batch,
    getSpectrumScore // 레거시
};
