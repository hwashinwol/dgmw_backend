%% `graph TD`는 Top-Down (위에서 아래로) 방향의 다이어그램을 의미합니다.
graph TD
    
    subgraph "사용자 영역 (Client)"
        User[사용자 (Browser)]
    end

    subgraph "프론트엔드 (Vercel / Netlify)"
        FE[React App<br>(AuthContext, /translate, /mypage)]
    end

    subgraph "백엔드 (AWS / GCP / Heroku)"
        API[Node.js / Express API<br>(/api/v1/...)]
        DB[(MariaDB / MySQL<br>Users, Jobs, Results)]
    end

    subgraph "외부 서비스 (3rd Party APIs)"
        Google[Google OAuth<br>(로그인 인증)]
        Stripe[Stripe<br>(결제 처리)]
        NCP[NCP Object Storage<br>(파일 입/출력 저장)]
        
        Gemini[Gemini 2.5 Flash<br>(AI 번역)]
        GoogleNMT[Google Translation<br>(기계 번역)]
        OpenAI35[ChatGPT-3.5<br>(AI 번역)]
        OpenAI4o[ChatGPT-4o<br>(AI 번역/분석)]
        Anthropic[Claude Sonnet 4.5<br>(AI 번역)]
    end

    %% 화살표 (데이터 흐름)
    User -- "1. 웹사이트 접속" --> FE

    FE -- "2. API 요청 (JWT 포함)<br> (e.g., /translate, /user/me)" --> API

    API -- "3. 유저/작업/결과 저장" --> DB
    API -- "4. 구글 로그인/인증" --> Google
    API -- "5. 결제 세션/웹훅" --> Stripe
    API -- "6. 파일(입/출력) 저장" --> NCP
    
    %% --- 수정된 AI 요청 화살표 (각 모델 ID에 연결) ---
    API -- "7. 번역/분석 요청" --> Gemini
    API -- "7. 번역/분석 요청" --> GoogleNMT
    API -- "7. 번역/분석 요청" --> OpenAI35
    API -- "7. 번역/분석 요청" --> OpenAI4o
    API -- "7. 번역/분석 요청" --> Anthropic