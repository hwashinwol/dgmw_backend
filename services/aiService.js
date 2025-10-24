/**
 * @param {string} textToTranslate
 * @param {string} userStatus
 * @returns {Promise<Array<object>>}
 */

async function runAnalysis(textToTranslate, userStatus = 'free') {
    console.log(`[AI 서비스] "${textToTranslate.substring(0, 20)}..." 번역 시작... (등급: ${userStatus})`);
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    let mockResults = [];
    if (userStatus === 'paid') {
        mockResults = [
            {
                model_name: 'GPT-4o (Mock)',
                translated_text: 'This is a mock translation by GPT-4o.',
                bleu_score: 0.88,
                comet_score: 0.95,
                spectrum_score: 0.80
            },
            {
                model_name: 'Gemini 1.5 Pro (Mock)',
                translated_text: 'This is mock translation from Gemini 1.5 Pro.',
                bleu_score: 0.85,
                comet_score: 0.92,
                spectrum_score: 0.75
            },
            {
                model_name: 'Claude 3 Opus (Mock)',
                translated_text: 'This is mock translation from Claude 3 Opus',
                bleu_score: 0.85,
                comet_score: 0.92,
                spectrum_score: 0.75
            }
        ];
    } else {
        mockResults = [
            {
                model_name: 'DGMW-MT (Mock)',
                translated_text: 'This is a mock translation by DGMW-MT.',
                bleu_score: 0.75,
                comet_score: 0.80,
                spectrum_score: null
            },
            {
                model_name: 'ChatGPT-3.5 (Mock)',
                translated_text: 'This is mock translation from ChatGPT-3.5.',
                bleu_score: 0.82,
                comet_score: 0.88,
                spectrum_score: null
            }
        ];
    }
    console.log(`[AI 서비스] 번역 완료. ${mockResults.length}개 결과 반환.`);
    return mockResults;
}

// 함수 내보내기
module.exports = {runAnalysis};