# Devpost Submission: QuestMap.AI

## Inspiration
Learning a complex new subject is often overwhelming. You’re met with a "wall of data"—disorganized PDFs, long YouTube videos, and generic syllabi that don't care about what you already know. We wanted to build something that acts as a **GPS for Knowledge**. Inspired by the need for personalized education, we built QuestMap to turn static documents into dynamic, 3D learning journeys that adapt to the student in real-time.

## What it does
QuestMap is an AI-powered learning path generator that uses **Retrieval-Augmented Generation (RAG)** to create hyper-personalized curriculums. 
- **Upload Materials**: Users upload textbooks, notes, or exam results.
- **Visual Learning Path**: The AI generates an interactive 3D knowledge map with nodes representing sub-topics.
- **Strict Grounding**: Every practice scenario and recommended resource is strictly grounded in the uploaded documents—eliminating AI hallucinations.
- **RAG Relevance Guard**: Our custom retrieval logic ensured that even if you switch topics, your learning path stays isolated and focused, preventing "context pollution" from previous uploads.

## How we built it
- **The Brain**: Powered by **Google Gemini 1.5 Flash**, we used advanced prompt engineering for structured JSON generation and strict RAG grounding.
- **Vector Search**: We used **Pinecone** to store and retrieve document embeddings in real-time.
- **Frontend**: A high-performance **React (Vite)** UI with **Framer Motion** for liquid animations and **Lucide** for a premium aesthetic.
- **Backend**: A **Node.js/Express** server that parallelizes RAG retrieval and AI generation to keep the experience snappy.
- **Persistence**: **MongoDB Atlas** stores user profiles and historical learning trajectories.

## Challenges we ran into
- **Context Pollution**: Early on, documents from previous sessions (like research papers) were bleeding into new, unrelated topics (like sports). We solved this by implementing a **Relevance Guard** with a high semantic threshold (0.65) and "Domain-Aware" AI instructions.
- **Hallucinated URLs**: AI often makes up YouTube links. We mitigated this by generating specific search queries and resolving them via APIs to ensure every resource link actually works.
- **UI Lag**: Generating a map, quizzes, and resources simultaneously takes time. We moved to a parallelized architecture on the frontend to fetch data in chunks, keeping the user interface responsive.

## Accomplishments that we're proud of
- **True Grounding**: Building a system where the AI tutor actually says "Based on your uploaded context..." and refuses to make up jargon that isn't in your text.
- **The Aesthetics**: Creating a dashboard that feels less like a spreadsheet and more like a high-end command center for learning.
- **Semantic Separation**: Successfully engineering the RAG pipeline to distinguish between broad foundational topics and narrow specialized research.

## What we learned
- **Prompt Reliability**: We learned that `responseMimeType: 'application/json'` is a lifesaver for building stable AI-driven applications.
- **Semantic Nuance**: We discovered that "related" doesn't always mean "relevant"—and learned how to tune vector search to respect strict domain boundaries.

## What's next for QuestMap
- **Collaborative Quests**: Shared learning maps for study groups.
- **Mobile Companion**: AR-powered learning maps you can explore on your phone.
- **Advanced Assessment**: Deep-link quizzes that identify precisely which paragraph of your textbook you need to re-read.

## Built With

- **Languages**: JavaScript (ES6+), HTML5, CSS3, Markdown
- **Frameworks & Libraries**: React.js, Vite, Express.js, Framer Motion (Animations), Lucide React (Icons), Tailwind CSS, Mongoose, Multer (File Processing), PDF-Parse, Mammoth (.docx)
- **AI & ML**: Google Gemini 1.5 Flash (LLM), Google Gemini Embeddings (Vectorization)
- **Databases & Vector Stores**: Pinecone (Vector DB), MongoDB Atlas (User Profiles & History)
- **Platforms & APIs**: Firebase (Authentication), YouTube Search API & Google Custom Search (Resource resolving)
- **Runtime & Tools**: Node.js, Git, PM2 (Process Management), npm/npx
