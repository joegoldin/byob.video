const CopyUrl = {
  mounted() {
    this.el.addEventListener("click", () => {
      const url = this.el.dataset.url;
      navigator.clipboard.writeText(url).then(() => {
        const original = this.el.textContent;
        this.el.textContent = "Copied!";
        setTimeout(() => {
          this.el.textContent = original;
        }, 1500);
      });
    });
  },
};

export default CopyUrl;
