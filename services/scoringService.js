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

        if (wordCount === 0) return 0;

        // 3. 띄어쓰기를 제외한 '순수 글자 수' 계산
        const charCount = words.reduce((acc, word) => acc + word.length, 0);

        // 4. 어절당 평균 글자 수 (ACLW)
        const aclw = charCount / wordCount;
        
        return Math.round(aclw * 100) / 100;

    } catch (e) {
        logger.error('복잡성 계산 실패:', e);
        return null;
    }
}

/**
 * 2. 스펙트럼 점수 (GPT-4o 평가)
 * @param {string} originalText
 * @param {string} translatedText
 * @param {string} selected_domain
 * @returns {number | null} 1.0(직역) ~ 10.0(의역)
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
        } catch (parseError) { // ⭐️ 1. 에러 객체(parseError)를 받습니다.
            // ⭐️ 2. 구조화된 로깅으로 수정합니다.
            logger.error("Spectrum Score JSON 파싱 실패:", { 
                rawText: raw, 
                message: parseError.message, 
                stack: parseError.stack 
            });
            return null;
        }
    } catch (apiError) { // ⭐️ 1. 에러 객체(apiError)를 받습니다.
        // ⭐️ 2. 구조화된 로깅으로 수정합니다.
        logger.error("Spectrum Score API 호출 실패:", { 
            message: apiError.response?.data || apiError.message,
            stack: apiError.stack
        });
        return null;
    }
}

module.exports = {
    getComplexityScore,
    getSpectrumScore
};
