import "./CommissionJourney.css";
export const commissionSteps = ["Import source", "Match & review", "Carrier payment", "Post earnings", "Review payroll", "Employee payment", "Complete"];
export default function CommissionJourney({ nextStep, activeStep = nextStep, choose }: { nextStep: number; activeStep?: number; choose: (step: number) => void }) {
  return <nav aria-label="Commission workflow"><ol className="commission-journey">
    {commissionSteps.map((title, i) => <li key={title} className={i < nextStep ? "complete" : ""}>
      <button type="button" disabled={i > nextStep && i !== activeStep} aria-label={`Step ${i + 1}: ${title}${i < nextStep ? ", complete" : i === nextStep ? ", current" : ", up next"}`} aria-current={activeStep === i ? "step" : undefined} onClick={() => choose(i)}>
        <span>{i < nextStep ? "✓" : i + 1}</span><span>{title}<small>{i < nextStep ? "Complete" : i === nextStep ? "Current step" : "Up next"}</small></span>
      </button>
    </li>)}
  </ol></nav>;
}
