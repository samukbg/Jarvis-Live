export class DialogueManager {
  constructor(options) {
    this.speak = options.speak || (() => {});
    this.acknowledgements = {
      en: ['Let me check that for you.', 'Sure.', 'Give me a moment.', 'I\'ll handle that.', 'Working on it.'],
      pt: ['Claro.', 'Um momento.', 'Vou tratar disso.', 'Deixe comigo.', 'Estou nisso.'],
      es: ['Claro.', 'Un momento.', 'Voy a ver eso.', 'Déjamelo a mí.', 'En ello.'],
      fr: ['Bien sûr.', 'Un instant.', 'Laissez-moi vérifier.', 'Je m\'en occupe.'],
      de: ['Klar.', 'Einen Moment.', 'Ich kümmere mich darum.', 'Bin schon dran.'],
      it: ['Certo.', 'Un momento.', 'Me ne occupo io.', 'Ci penso io.'],
      ja: ['かしこまりました。', '少々お待ちください。', '確認します。'],
      zh: ['好的。', '稍等片刻。', '我来看看。', '马上处理。']
    };
    this.progressPhrases = {
      en: {
        25: ['Getting started...', 'Let me look into that.'],
        50: ['Making progress...', 'Almost halfway there.'],
        75: ['Nearly done.', 'Finishing up now.']
      },
      pt: {
        25: ['Começando...', 'A analisar isso.'],
        50: ['A progredir...', 'Quase a meio.'],
        75: ['Quase pronto.', 'A terminar agora.']
      }
    };
  }

  acknowledgeTask(language = 'en') {
    const lang = language.split('-')[0].toLowerCase();
    const phrases = this.acknowledgements[lang] || this.acknowledgements.en;
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    this.speak(phrase, { interrupt: true });
  }

  onProgress(progress, language = 'en') {
    const lang = language.split('-')[0].toLowerCase();
    if (progress % 25 === 0) {
      const langPhrases = this.progressPhrases[lang] || this.progressPhrases.en;
      const options = langPhrases[progress];
      if (options && Math.random() > 0.5) { 
        const phrase = options[Math.floor(Math.random() * options.length)];
        this.speak(phrase, { interrupt: false });
      }
    }
  }

  presentResult(result) {
    if (!result) return;
    const spoken = result
      .replace(/^#+\s+/gm, '')
      .replace(/\*\*/g, '')
      .replace(/[*`_~]/g, '')
      .replace(/^[-▸•]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 500);
    if (spoken) {
      this.speak(spoken, { interrupt: true });
    }
  }
}
