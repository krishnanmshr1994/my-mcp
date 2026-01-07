import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

export default class EmailAssistant extends LightningElement {
    @api content; // The text from the LLM

    get isDraft() {
        return this.content && (this.content.includes('Subject:') || this.content.includes('**Subject**'));
    }

    get subject() {
        const match = this.content.match(/(?:Subject|Subject Line):\s*(.*)/i);
        return match ? match[1] : 'No Subject Provided';
    }

    get body() {
        // Removes the subject line from the content to display only the body
        return this.content.replace(/(?:Subject|Subject Line):.*\n/i, '').trim()
                           .replace(/\n/g, '<br/>'); // Basic formatting
    }

    handleCopy() {
        const textArea = document.createElement("textarea");
        textArea.value = `Subject: ${this.subject}\n\n${this.body.replace(/<br\/>/g, '\n')}`;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);

        this.dispatchEvent(new ShowToastEvent({
            title: 'Success',
            message: 'Email draft copied to clipboard!',
            variant: 'success'
        }));
    }
}