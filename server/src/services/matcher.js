// Extract a domain like "flipkart.com" from 'Flipkart Careers <no-reply@mail.flipkart.com>'
function extractDomain(fromHeader) {
    const match = fromHeader.match(/@([a-zA-Z0-9.-]+)/);
    if (!match) return null;
    let domain = match[1].toLowerCase();
    // strip common mailer subdomains: mail.flipkart.com -> flipkart.com
    const parts = domain.split('.');
    if (parts.length > 2) domain = parts.slice(-2).join('.');
    return domain;
}

// Does this email belong to this application?
function matchesApplication(domain, fromHeader, app) {
    if (!domain) return false;
    if (app.company_domain && domain === app.company_domain.toLowerCase()) return true;
    // fallback: company name appears in the domain or the sender line
    const name = app.company.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (name.length >= 3) {
        if (domain.replace(/[^a-z0-9]/g, '').includes(name)) return true;
        if (fromHeader.toLowerCase().replace(/[^a-z0-9]/g, '').includes(name)) return true;
    }
    return false;
}

// What kind of email is it?
function classify(subject, snippet) {
    const text = (subject + ' ' + snippet).toLowerCase();
    if (/unfortunately|not (be )?moving forward|other candidates|regret to|not selected/.test(text)) return 'rejected';
    if (/offer letter|pleased to (extend|offer)|congratulations/.test(text)) return 'offer';
    if (/interview|schedule a (call|meeting)|next round|availability|meet the team/.test(text)) return 'interview';
    if (/assessment|coding (test|challenge)|hackerrank|codility|online test/.test(text)) return 'assessment';
    if (/received your application|thank(s| you) for applying|application (was )?(submitted|received)/.test(text)) return 'confirmed';
    return null;
}

// Never move a status backward; 'rejected' always wins
const RANK = { applied: 0, confirmed: 1, assessment: 2, interview: 3, offer: 4 };
function nextStatus(current, detected) {
    if (detected === 'rejected') return 'rejected';
    if (current === 'rejected' || current === 'offer') return current;
    if ((RANK[detected] ?? -1) > (RANK[current] ?? 0)) return detected;
    return current;
}

module.exports = { extractDomain, matchesApplication, classify, nextStatus };