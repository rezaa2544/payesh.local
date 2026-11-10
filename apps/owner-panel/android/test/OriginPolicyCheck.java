import ir.payesh.owner.OriginPolicy;
public class OriginPolicyCheck { static int f=0,n=0; static void eq(Object a,Object b){n++; if(a==null?b!=null:!a.equals(b)){f++;System.out.println("FAIL "+a+" != "+b);}}
public static void main(String[] x){
 eq(OriginPolicy.normalize("https://OWNER.A.B/"),"https://owner.a.b");
 eq(OriginPolicy.normalize(" https://a.b:8443 "),"https://a.b:8443");
 eq(OriginPolicy.normalize("https://a.b:443"),"https://a.b");
 eq(OriginPolicy.normalize("http://localhost:8095"),"http://localhost:8095");
 eq(OriginPolicy.normalize("http://127.0.0.1:8095/"),"http://127.0.0.1:8095");
 eq(OriginPolicy.normalize("http://owner.a.b"),null);
 eq(OriginPolicy.normalize("https://a.b/path"),null);
 eq(OriginPolicy.normalize("https://a.b/?q=1"),null);
 eq(OriginPolicy.normalize("https://u:p@a.b"),null);
 eq(OriginPolicy.normalize("javascript:alert(1)"),null);
 eq(OriginPolicy.normalize("file:///etc/passwd"),null);
 eq(OriginPolicy.normalize(""),null);
 eq(OriginPolicy.normalize("a.b"),null);
 eq(OriginPolicy.sameOrigin("https://a.b/x/y?z#q","https://a.b"),true);
 eq(OriginPolicy.sameOrigin("https://a.b:443/x","https://a.b"),true);
 eq(OriginPolicy.sameOrigin("https://a.b.x/","https://a.b"),false);
 eq(OriginPolicy.sameOrigin("http://a.b/","https://a.b"),false);
 eq(OriginPolicy.sameOrigin("https://a.b:8443/","https://a.b"),false);
 eq(OriginPolicy.sameOrigin("https://evil@a.b/","https://a.b"),false);
 eq(OriginPolicy.sameOrigin(null,"https://a.b"),false);
 eq(OriginPolicy.sameOrigin("https://a.b/",null),false);
 System.out.println("ORIGIN-POLICY-JAVA checks="+n+" failures="+f); System.exit(f==0?0:1);}}
